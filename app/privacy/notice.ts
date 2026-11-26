/**
 * The text of the privacy notice at /privacy (ADR 0034). This module holds
 * the notice and nothing else, so a later wording change by Ambak Legal is
 * an edit to this one file: change the version line below with it, and the
 * version expected by tests/unit/privacy-notice.test.ts in the same pull
 * request.
 *
 * Every string exported here is notice text; the unit test checks them all
 * and counts their words. The page shows each section in order: its heading,
 * its paragraphs, its list, then the lines after the list. A list item's
 * lead, when it has one, is shown just before its text.
 */

export type PrivacyNoticeItem = {
  readonly lead?: string;
  readonly text: string;
};

export type PrivacyNoticeSection = {
  readonly heading: string;
  readonly paragraphs?: readonly string[];
  readonly items?: readonly PrivacyNoticeItem[];
  readonly after?: readonly string[];
};

export const PRIVACY_NOTICE_TITLE = "Privacy Notice";

export const PRIVACY_NOTICE_VERSION = "Version 1, draft for legal review, 2026-11-26";

export const PRIVACY_NOTICE_INTRO: readonly string[] = [
  "This notice explains what personal data this learning platform holds about you, why, who can see it, how long it is kept and what you can ask for.",
  "In this notice, \"your organisation\" means the organisation that gave you access to this platform (usually your employer). It gives you access to this platform and assigns your training. It may also give you its own privacy notice.",
];

export const PRIVACY_NOTICE_SECTIONS: readonly PrivacyNoticeSection[] = [
  {
    heading: "What the platform holds about you",
    items: [
      {
        lead: "Account details:",
        text: "your name, work email address, username and employee ID. The sign-in service holds your password only in scrambled (hashed) form. With single sign-on, you sign in through your organisation's own system.",
      },
      {
        lead: "Work details, entered by your organisation or its connected HR system:",
        text: "such as your platform role, designation, grade, department, branch, location, joining date, managers, teams and groups.",
      },
      {
        lead: "Optional details, added by you or an administrator:",
        text: "phone number, gender, date of birth and a profile photo.",
      },
      {
        lead: "Learning records:",
        text: "what is assigned to you, when you open it, your progress, your answers and actions inside courses, scores, pass or fail results, completion dates, attempts and review visits, requests for another attempt with your reason, your language choice, ratings, feedback and comments, points, badges, leaderboard places, certificates, help requests, and which announcements you have seen.",
      },
      {
        lead: "Message records:",
        text: "the emails and reminders sent to you, with the address, subject, time and whether sending worked.",
      },
      {
        lead: "Sign-in and security records:",
        text: "cookies that keep you signed in, records of your sign-ins, and password reset codes, held only in scrambled form, with the network address and browser type of each request.",
      },
      {
        lead: "Error reports:",
        text: "if something goes wrong in your browser, a report may be sent to an error-reporting service. It can include the page address, your browser type, the steps before the error and a recording of the screen in which text, images and typed input are hidden. The service also receives timing measurements from some page visits.",
      },
    ],
  },
  {
    heading: "Why it is used",
    paragraphs: [
      "Your organisation uses this data as part of your employment, for your training and development:",
    ],
    items: [
      { text: "to give you your training, keep your place, and record what you complete and your results;" },
      { text: "to show your progress to the people listed below;" },
      { text: "to send you sign-in emails, reminders and announcements;" },
      { text: "to run points, badges and leaderboards, where your organisation uses them;" },
      { text: "to keep the platform secure, prevent misuse, and find and fix faults;" },
      { text: "to share your training records with your organisation's own systems, if it turns this on." },
    ],
    after: ["The platform shows no advertising and uses no marketing trackers."],
  },
  {
    heading: "Who can see it",
    items: [
      {
        lead: "You:",
        text: "your profile and your own learning records.",
      },
      {
        lead: "Your organisation's administrators and data analysts:",
        text: "the details and learning records of everyone in the organisation, including reports and downloads.",
      },
      {
        lead: "Your managers (up to three levels above you, as named in your record):",
        text: "your progress and results. Only your direct manager sees your email address there.",
      },
      {
        lead: "Other people in your organisation who use the platform:",
        text: "the details in your profile (your name, work email, photo and any optional details) and, on leaderboards, your place with your points, average score, active days and streak, and your designation, team, branch and city where recorded. Where your organisation allows it, you can hide yourself from leaderboards on your profile page; administrators still see you. Your photo's web address works for anyone who has it.",
      },
      {
        lead: "The platform's operators:",
        text: "to give support, they can enter your organisation's workspace with administrator access. Each visit lasts at most one hour and is recorded. They also run the platform's database and its backups, and can reach your data there when they maintain, repair or restore the platform.",
      },
    ],
  },
  {
    heading: "Systems your organisation can connect",
    paragraphs: ["These are off unless your organisation turns them on."],
    items: [
      {
        lead: "An HR or business system:",
        text: "it can create, update and deactivate your account, sign you in, and read your courses, progress, scores and completions. When you complete a course, the platform can send it your employee ID, email address, the course, your score, whether you passed and when.",
      },
      {
        lead: "A learning record store:",
        text: "your organisation can have a copy of your learning records sent to its own store. Each copy carries your name, email address, employee ID and work details (such as your role, designation, grade, branch, location, joining date, manager, teams and groups).",
      },
    ],
  },
  {
    heading: "Service providers",
    paragraphs: ["The platform relies on:"],
    items: [
      { text: "a database, sign-in and file storage provider, which also hands emails to the email service;" },
      { text: "a hosting provider that runs the website and keeps technical logs of requests;" },
      { text: "an automation service that runs scheduled jobs, including backups;" },
      { text: "a separate storage provider that holds database backups (new backups are encrypted);" },
      { text: "an error-reporting service (see above);" },
      { text: "your organisation's own email service or, for some messages to administrators, the platform's email account." },
    ],
  },
  {
    heading: "How it is protected",
    items: [
      { text: "Database rules keep each organisation's data apart. Each person sees only what their role allows." },
      { text: "Passwords and reset codes are stored only in scrambled form, and new database backups are encrypted." },
      { text: "Your training history is not deleted or rewritten; a correction is recorded alongside it." },
    ],
    after: ["If a security breach affects your personal data, you will be told as the law requires."],
  },
  {
    heading: "How long it is kept",
    paragraphs: [
      "The platform does not delete your data on its own. Your training history and profile are kept as a lasting record, also after you leave your organisation's workspace, and copies stay in database backups until they are deleted.",
    ],
  },
  {
    heading: "Your rights",
    paragraphs: ["You can ask your organisation:"],
    items: [
      { text: "for a summary of the personal data held about you, how it is used and who it has been shared with;" },
      { text: "to correct, complete or update your data. You can change your own personal details and photo on your profile page; administrators change your work details;" },
      { text: "to erase personal data that is no longer needed. Data your organisation still needs for an employment or legal purpose, such as your training history, may be kept;" },
      { text: "to name another person who can use these rights for you if you die or become unable to act." },
    ],
  },
  {
    heading: "Questions and complaints",
    paragraphs: [
      "Send any question, request or complaint about your personal data to your organisation's HR or Learning & Development team, or to the administrator who invited you. If you are not satisfied with the answer, you can complain to the Data Protection Board of India.",
    ],
  },
  {
    heading: "Children",
    paragraphs: ["This platform is for work training. It is not meant for anyone under 18."],
  },
  {
    heading: "Changes to this notice",
    paragraphs: ["This notice may change. The version line at the top shows which version you are reading."],
  },
];
