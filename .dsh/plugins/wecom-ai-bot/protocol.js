/** Wire constants shared by the Host plugin and the browser settings page. */
export const PACKAGE_NAME = 'dsh-wecom-ai-bot';
/** Loader entry id from cordis.patch.yml; also the Config form namespace. */
export const CONFIG_NAMESPACE = 'wecom-ai-bot';
export const DEFAULT_SECRET_REF = 'WECOM_BOT_SECRET';
/** Authenticated Connection Fetch route; the browser reads it document-relative. */
export const STATE_ROUTE = '/api/wecom-ai-bot/state';
/** Authenticated Connection Fetch route that applies settings/binding/name edits. */
export const STORE_ROUTE = '/api/wecom-ai-bot/store';
/** Directory below the DSH home that holds this plugin's own data. */
export const PLUGIN_HOME_DIRECTORY = 'wecom-ai-bot';
/** The plugin's own default workspace directory, below {@link PLUGIN_HOME_DIRECTORY}. */
export const DEFAULT_WORKSPACE_DIRECTORY = 'workspace';
/** Persisted plugin store version (`settings.json`). */
export const STORE_VERSION = '0.2';
export const STORE_FILE = 'settings.json';
/** Upper bound on persisted authorizations (persons + groups). */
export const MAX_BINDINGS = 500;
/** Longest accepted nickname / id, in characters. */
export const MAX_LABEL_CHARS = 60;
