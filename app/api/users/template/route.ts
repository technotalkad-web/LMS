import { NextResponse } from "next/server";

/**
 *   GET /api/users/template
 *
 * Returns a starter CSV for bulk user upload. Includes the header row plus
 * one example row so admins can see the expected format.
 */
export async function GET() {
  const header = [
    "first_name",
    "last_name",
    "unique_id",
    "gender",
    "status",
    "dob",
    "doj",
    "email",
    "username",
    "password",
    "phone",
    "grade",
    "designation",
    "role",
    "line_manager_id",
    "indirect_manager_id",
    "lms_role",
    "node_id",
    "city",
    "state",
  ].join(",");

  const example = [
    "Jane",
    "Doe",
    "EMP-1001",
    "female",
    "active",
    "1992-03-15",
    "2023-08-01",
    "jane.doe@example.com",
    "jane.doe@example.com",
    "",
    "+1-555-0100",
    "L3",
    "Senior Engineer",
    "Backend Lead",
    "",
    "",
    "user",
    "ENG-PLATFORM",
    "Austin",
    "TX",
  ].join(",");

  const body = `${header}\n${example}\n`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="users-template.csv"',
    },
  });
}
