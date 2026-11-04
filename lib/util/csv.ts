/**
 * One CSV cell, for every CSV the app writes: the course learners export, the
 * path learners export and the org Reports page's CsvButton.
 *
 * Formula guard (ADR 0014 PR 1b): a string cell
 * whose first character is =, +, -, @, tab or CR would run as a formula when
 * an admin opens the file in Excel, Sheets or LibreOffice. Such a cell gets a
 * leading ' so it reads as text. PR 1b adds the first learner-written cell
 * (the course CSV's "Grant reason"); names, emails, course and team titles
 * were already exposed. Numbers and empty cells are unchanged, and so is a
 * plain number written as text (/^-?\d+(\.\d+)?$/, such as "-20"): it is a
 * value, not a formula. Otherwise only the literal first
 * character is tested.
 *
 * Then the usual quoting: a cell holding a comma, a double quote, LF or CR is
 * wrapped in double quotes, with each inner double quote doubled.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
