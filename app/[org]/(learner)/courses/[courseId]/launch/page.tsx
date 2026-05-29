import { redirect } from "next/navigation";
import { originFromRequest } from "@/lib/http/origin";
import { randomBytes } from "crypto";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { ScormRuntime } from "./scorm-runtime";
import { Cmi5Runtime } from "./cmi5-runtime";
import type { CmiData } from "@/lib/scorm/types";

type Course = {
  id: string;
  organization_id: string;
  current_version_id: string | null;
  title: string;
  is_active?: boolean;
};

type Version = {
  id: string;
  manifest_type: "scorm12" | "cmi5";
  launch_url: string;
  manifest_data: { raw?: { courseId?: string; auId?: string } };
};

export default async function LaunchPage({
  params,
}: {
  params: Promise<{ org: string; courseId: string }>;
}) {
  const { org: orgSlug, courseId } = await params;
  const { user, org } = await requireOrgAccess(orgSlug);

  const supabase = await createClient();
  const { data: course } = await supabase
    .from("courses")
    .select("id, organization_id, current_version_id, title, is_active")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();

  if (!course || !(course as Course).current_version_id) {
    redirect(`/${orgSlug}/courses/${courseId}`);
  }
  if ((course as Course).is_active === false) {
    redirect(`/${orgSlug}/dashboard`);
  }
  const c = course as Course;

  const { data: version } = await supabase
    .from("course_versions")
    .select("id, manifest_type, launch_url, manifest_data")
    .eq("id", c.current_version_id!)
    .maybeSingle();
  if (!version) redirect(`/${orgSlug}/courses/${courseId}`);
  const v = version as Version;

  // PREREQ LOCK: if this course is in a learning path the user is assigned
  // to, every earlier step in that path must be completed first.
  const { data: pathStepRows } = await supabase
    .from("learning_path_courses")
    .select("path_id, step_number")
    .eq("course_id", courseId);
  const stepInPaths = (pathStepRows ?? []) as Array<{
    path_id: string;
    step_number: number;
  }>;
  if (stepInPaths.length > 0) {
    const pathIds = stepInPaths.map((s) => s.path_id);
    const { data: myTeamRows } = await supabase
      .from("team_members")
      .select("team_id, teams!inner(organization_id)")
      .eq("user_id", user.id);
    const myTeamIds = ((myTeamRows ?? []) as Array<{
      team_id: string;
      teams: { organization_id: string } | Array<{ organization_id: string }>;
    }>)
      .filter((r) => {
        const t = Array.isArray(r.teams) ? r.teams[0] : r.teams;
        return t?.organization_id === org.id;
      })
      .map((r) => r.team_id);
    const { data: paRows } = await supabase
      .from("learning_path_assignments")
      .select("path_id, assignee_type, user_id, team_id")
      .in("path_id", pathIds);
    const assignedPathIds = new Set(
      ((paRows ?? []) as Array<{
        path_id: string;
        assignee_type: "user" | "org" | "team";
        user_id: string | null;
        team_id: string | null;
      }>)
        .filter(
          (a) =>
            (a.assignee_type === "user" && a.user_id === user.id) ||
            a.assignee_type === "org" ||
            (a.assignee_type === "team" &&
              a.team_id &&
              myTeamIds.includes(a.team_id))
        )
        .map((a) => a.path_id)
    );
    if (assignedPathIds.size > 0) {
      const relevant = stepInPaths.filter((s) => assignedPathIds.has(s.path_id));
      const { data: allStepRows } = await supabase
        .from("learning_path_courses")
        .select("path_id, course_id, step_number")
        .in("path_id", Array.from(assignedPathIds));
      const allSteps = (allStepRows ?? []) as Array<{
        path_id: string;
        course_id: string;
        step_number: number;
      }>;
      const prereqCourseIds = new Set<string>();
      for (const s of relevant) {
        for (const a of allSteps) {
          if (a.path_id === s.path_id && a.step_number < s.step_number) {
            prereqCourseIds.add(a.course_id);
          }
        }
      }
      if (prereqCourseIds.size > 0) {
        const prereqIds = Array.from(prereqCourseIds);
        const { data: vRows } = await supabase
          .from("course_versions")
          .select("id, course_id")
          .in("course_id", prereqIds);
        const verToCourse = new Map<string, string>(
          ((vRows ?? []) as Array<{ id: string; course_id: string }>).map(
            (vr) => [vr.id, vr.course_id] as [string, string]
          )
        );
        const verIds = Array.from(verToCourse.keys());
        const { data: aRows } = verIds.length
          ? await supabase
              .from("course_attempts")
              .select("course_version_id, completion_status, success_status")
              .eq("user_id", user.id)
              .in("course_version_id", verIds)
          : { data: [] };
        const doneCourseIds = new Set<string>();
        for (const a of (aRows ?? []) as Array<{
          course_version_id: string;
          completion_status: string;
          success_status: string;
        }>) {
          const cid = verToCourse.get(a.course_version_id);
          if (!cid) continue;
          if (
            a.completion_status === "completed" ||
            a.success_status === "passed"
          ) {
            doneCourseIds.add(cid);
          }
        }
        const incomplete = prereqIds.filter((cid) => !doneCourseIds.has(cid));
        if (incomplete.length > 0) {
          redirect(`/${orgSlug}/dashboard?locked=${courseId}`);
        }
      }
    }
  }

  // Find or create the attempt.
  let attemptId: string | null = null;
  let cmi: CmiData = {};
  const { data: existing } = await supabase
    .from("course_attempts")
    .select("id, cmi_data")
    .eq("course_version_id", v.id)
    .eq("user_id", user.id)
    .eq("status", "in_progress")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    attemptId = existing.id;
    cmi = (existing.cmi_data ?? {}) as CmiData;
  } else {
    const { data: created } = await supabase
      .from("course_attempts")
      .insert({
        course_version_id: v.id,
        user_id: user.id,
        organization_id: org.id,
        status: "in_progress",
        cmi_data: {},
      })
      .select("id")
      .single();
    attemptId = created?.id ?? null;
  }
  if (!attemptId) {
    return <div className="p-10 text-red-700">Failed to create attempt.</div>;
  }

  const contentBase = `/${orgSlug}/courses/${courseId}/content/`;
  // Exit takes the learner back to their dashboard rather than the course
  // detail page; mid-course exits usually mean "I'm done for now", and the
  // dashboard is where they make their next pick.
  const backHref = `/${orgSlug}/dashboard`;

  // --- SCORM 1.2 path ---
  if (v.manifest_type === "scorm12") {
    if (!cmi["cmi.core.student_id"]) cmi["cmi.core.student_id"] = user.id;
    if (!cmi["cmi.core.student_name"]) {
      cmi["cmi.core.student_name"] = user.email ?? "Learner";
    }
    const launchSrc = contentBase + v.launch_url.replace(/^\/+/, "");
    return (
      <ScormRuntime
        attemptId={attemptId}
        initialCmi={cmi}
        iframeSrc={launchSrc}
        courseTitle={c.title}
        backHref={backHref}
      />
    );
  }

  // --- cmi5 path ---
  const svcUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const svc = createServiceClient(svcUrl, svcKey, {
    auth: { persistSession: false },
  });

  const authToken = randomBytes(32).toString("hex");
  const { data: token } = await svc
    .from("cmi5_launch_tokens")
    .insert({
      auth_token: authToken,
      attempt_id: attemptId,
    })
    .select("fetch_token")
    .single();

  if (!token) {
    return (
      <div className="p-10 text-red-700">Failed to mint cmi5 launch token.</div>
    );
  }

  // xAPI endpoint URL must point at the live host so the SCORM/cmi5
  // player (in the iframe) can POST progress back. The helper handles
  // the build-time-inlining bug (#145, #146) — keep the empty-string
  // fallback so this never regresses to localhost.
  const host = (await originFromRequest()) || "https://localhost:3000";

  const launchParams = new URLSearchParams({
    endpoint: `${host}/api/xapi/`,
    fetch: `${host}/api/xapi/fetch?fetch_token=${token.fetch_token}`,
    actor: JSON.stringify({
      objectType: "Agent",
      name: user.email ?? "Learner",
      account: {
        homePage: host,
        name: user.id,
      },
    }),
    registration: attemptId,
    activityId:
      v.manifest_data?.raw?.auId ??
      v.manifest_data?.raw?.courseId ??
      `urn:uuid:${v.id}`,
  });

  const launchPath = v.launch_url.replace(/^\/+/, "");
  const sep = launchPath.includes("?") ? "&" : "?";
  const iframeSrc = `${contentBase}${launchPath}${sep}${launchParams}`;

  return (
    <Cmi5Runtime
      iframeSrc={iframeSrc}
      courseTitle={c.title}
      backHref={backHref}
    />
  );
}
