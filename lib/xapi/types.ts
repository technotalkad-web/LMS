/**
 * Minimal xAPI types. The spec is large; we model what cmi5 actually uses.
 *
 * Reference:
 *   xAPI spec       — https://github.com/adlnet/xAPI-Spec
 *   cmi5 profile    — https://github.com/AICC/CMI-5_Spec_Current
 */

export interface XapiAccount {
  homePage: string;
  name: string;
}

export interface XapiActor {
  objectType?: "Agent";
  name?: string;
  mbox?: string;
  account?: XapiAccount;
}

export interface XapiVerb {
  id: string;
  display?: Record<string, string>;
}

export interface XapiActivity {
  objectType: "Activity";
  id: string;
  definition?: Record<string, unknown>;
}

export interface XapiResult {
  score?: {
    scaled?: number; // 0..1
    raw?: number;
    min?: number;
    max?: number;
  };
  success?: boolean;
  completion?: boolean;
  duration?: string; // ISO 8601
  response?: string;
  extensions?: Record<string, unknown>;
}

export interface XapiStatement {
  id?: string;
  actor: XapiActor;
  verb: XapiVerb;
  object: XapiActivity | { objectType?: string; id?: string };
  result?: XapiResult;
  context?: Record<string, unknown>;
  timestamp?: string;
  stored?: string;
}

// cmi5 / xAPI verb IRIs we care about.
export const VERBS = {
  launched:    "http://adlnet.gov/expapi/verbs/launched",
  initialized: "http://adlnet.gov/expapi/verbs/initialized",
  completed:   "http://adlnet.gov/expapi/verbs/completed",
  passed:      "http://adlnet.gov/expapi/verbs/passed",
  failed:      "http://adlnet.gov/expapi/verbs/failed",
  terminated:  "http://adlnet.gov/expapi/verbs/terminated",
  abandoned:   "https://w3id.org/xapi/adl/verbs/abandoned",
  waived:      "https://w3id.org/xapi/adl/verbs/waived",
  satisfied:   "https://w3id.org/xapi/adl/verbs/satisfied",
} as const;
