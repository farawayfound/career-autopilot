// Hosts that list MANY employers' postings: the ATS vendors and the job
// boards. Lives in its own module so a reader of a fetched page
// (lib/posting-identity.mjs) can ask "is this a board?" without importing
// lib/leads.mjs, which imports lib/jd.mjs and would close an import cycle.
// lib/leads.mjs re-exports the list, so its existing importers are unchanged.
export const KNOWN_JOB_BOARD_HOSTS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com',
  'recruitee.com', 'myworkdayjobs.com', 'icims.com', 'linkedin.com', 'indeed.com',
  'glassdoor.com', 'remoteok.com', 'remotive.com', 'weworkremotely.com',
  'wellfound.com', 'angel.co', 'ziprecruiter.com', 'dice.com', 'monster.com',
  'builtin.com', 'otta.com', 'himalayas.app',
];

export function isKnownJobBoardHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return KNOWN_JOB_BOARD_HOSTS.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}
