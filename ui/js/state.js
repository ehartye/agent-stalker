export const API = '';

export const state = {
  activeSessions: [],
  archivedSessions: [],
  selectedSessionIds: new Set(),
  sessionAgents: {},
  sessionTasks: {},
  events: [],
  tools: [],
  stats: {},
  searchText: '',
  sessionSearchText: '',
  agentFilters: new Set(),
  toolChipFilters: new Set(),
  eventTypeFilters: new Set(),
  isLive: true,
  lastTimestamp: 0,
  eventsFullyLoaded: false,
  loadingMore: false,
};
