/**
 * Shared lifecycle helpers — drive the real app APIs the same way the engine
 * spec proved out, so journey specs stay declarative.
 */
import { Browser, APIRequestContext, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { svc } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";

const FIXTURES = path.resolve(__dirname, "../fixtures");

export interface CourseHandle {
  courseId: string;
  versionId: string;
  manifestType: string;
}

export async function courseHandle(courseId: string): Promise<CourseHandle> {
  const { data: course } = await svc()
    .from("courses")
    .select("current_version_id")
    .eq("id", courseId)
    .single();
  const versionId = (course as { current_version_id: string }).current_version_id;
  const { data: ver } = await svc()
    .from("course_versions")
    .select("manifest_type")
    .eq("id", versionId)
    .single();
  return {
    courseId,
    versionId,
    manifestType: (ver as { manifest_type: string }).manifest_type,
  };
}

/** Upload a fixture zip via POST /api/courses/upload as the given admin ctx. */
export async function uploadCourse(
  adminReq: APIRequestContext,
  orgSlug: string,
  zip: string
): Promise<CourseHandle> {
  const res = await adminReq.post("/api/courses/upload", {
    multipart: {
      orgSlug,
      file: {
        name: zip,
        mimeType: "application/zip",
        buffer: fs.readFileSync(path.join(FIXTURES, zip)),
      },
    },
  });
  expect(res.ok(), `${zip} upload → ${res.status()}: ${await res.text()}`).toBeTruthy();
  return courseHandle((await res.json()).courseId as string);
}

export async function assignCourse(
  adminReq: APIRequestContext,
  orgSlug: string,
  courseId: string,
  userId: string
): Promise<void> {
  const res = await adminReq.post("/api/assignments", {
    data: { orgSlug, courseId, userIds: [userId] },
  });
  expect(res.ok(), `assign ${courseId} → ${res.status()}: ${await res.text()}`).toBeTruthy();
}

/** GET the launch page (server component) to create/resume the attempt. */
export async function launch(
  learnerReq: APIRequestContext,
  orgSlug: string,
  courseId: string
): Promise<void> {
  const res = await learnerReq.get(`/${orgSlug}/courses/${courseId}/launch`);
  expect(res.ok(), `launch ${courseId} → ${res.status()}`).toBeTruthy();
}

export async function latestAttemptId(
  versionId: string,
  userId: string
): Promise<string> {
  const { data } = await svc()
    .from("course_attempts")
    .select("id")
    .eq("course_version_id", versionId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  expect(data, "an attempt should exist after launch").toBeTruthy();
  return (data as { id: string }).id;
}

export interface AttemptRow {
  id: string;
  status: string;
  completion_status: string;
  success_status: string;
  score: number | null;
  completed_at: string | null;
  cmi_data: Record<string, unknown>;
}

export async function attemptsFor(
  versionId: string,
  userId: string
): Promise<AttemptRow[]> {
  const { data } = await svc()
    .from("course_attempts")
    .select("id, status, completion_status, success_status, score, completed_at, cmi_data")
    .eq("course_version_id", versionId)
    .eq("user_id", userId)
    .order("started_at", { ascending: true });
  return (data ?? []) as AttemptRow[];
}

/** POST a SCORM commit as the learner. */
export async function scormCommit(
  learnerReq: APIRequestContext,
  attemptId: string,
  cmi: Record<string, string>,
  finished: boolean
): Promise<void> {
  const res = await learnerReq.post(`/api/scorm/${attemptId}/commit`, {
    data: { cmi, finished },
  });
  expect(res.ok(), `commit ${attemptId} → ${res.status()}: ${await res.text()}`).toBeTruthy();
}

/** Drive a cmi5 attempt to passed+completed via the xAPI endpoints. */
export async function cmi5Pass(
  learnerReq: APIRequestContext,
  attemptId: string,
  actor: { email: string; id: string; homePage: string | undefined },
  scaled = 0.9
): Promise<void> {
  const { data: tok } = await svc()
    .from("cmi5_launch_tokens")
    .select("fetch_token")
    .eq("attempt_id", attemptId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  expect(tok, "a cmi5 launch token should exist").toBeTruthy();

  const fetchRes = await learnerReq.post(
    `/api/xapi/fetch?fetch_token=${(tok as { fetch_token: string }).fetch_token}`
  );
  expect(fetchRes.ok(), `xapi/fetch → ${fetchRes.status()}`).toBeTruthy();
  const authToken = (await fetchRes.json())["auth-token"] as string;

  const send = async (verb: string, result?: unknown) => {
    const res = await learnerReq.post("/api/xapi/statements", {
      headers: {
        Authorization: authToken,
        "Content-Type": "application/json",
        "X-Experience-API-Version": "1.0.3",
      },
      data: {
        actor: {
          objectType: "Agent",
          name: actor.email,
          account: { homePage: actor.homePage, name: actor.id },
        },
        verb: { id: verb },
        object: { objectType: "Activity", id: "https://qa.bot/cmi5/au1" },
        context: { registration: attemptId },
        result,
      },
    });
    expect(res.ok(), `statement ${verb} → ${res.status()}: ${await res.text()}`).toBeTruthy();
  };

  await send("http://adlnet.gov/expapi/verbs/launched");
  await send("http://adlnet.gov/expapi/verbs/initialized");
  await send("http://adlnet.gov/expapi/verbs/passed", { score: { scaled } });
  await send("http://adlnet.gov/expapi/verbs/completed", { completion: true });
  await send("http://adlnet.gov/expapi/verbs/terminated");
}

/** Re-export so specs import from one place. */
export { authedContext };
export type { Browser };
