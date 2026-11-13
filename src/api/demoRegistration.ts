import { API_V2_BASE_URL } from '../config/api';
import { getRuntimeBrokerConfiguration, isDesktopBackendTarget } from '../config/backendTarget.js';
import { toLocalDevProxyUrl } from '../config/localDevProxy';
import { ApiError, apiClient } from './client';
import { authV2Api } from './trade';
import type { AccountClassificationFields } from '../types/api';

/** Position accounting of a new demo account. Absent = the broker's hedging demo default. */
export type DemoAccountMode = 'hedging' | 'netting';

export interface DemoRegistrationInput {
  name: string;
  email: string;
  password: string;
  /** Only 'netting' is sent; hedging keeps the request body unchanged. */
  accountMode?: DemoAccountMode;
}

/** Demo sign-up options the broker publishes on GET {v2}/broker/config. */
export interface DemoRegistrationModes {
  /** `demo_registration_enabled`; null when the broker did not say (today's behaviour: offered). */
  hedging: boolean | null;
  /** `demo_netting_registration_enabled`; true only when the broker says exactly true (fail closed). */
  netting: boolean;
}

export const DEMO_NETTING_NOT_CONFIGURED_MESSAGE =
  'Demo netting accounts are not available from this broker right now. Please try again later or contact the broker.';
export const DEMO_NETTING_UNAVAILABLE_MESSAGE =
  'The demo netting account could not be created right now. Nothing was created. Please try again later.';
export const DEMO_ACCOUNT_MODE_MISMATCH_MESSAGE =
  'The demo account was created with a different account mode than requested, so you were not logged in. An account may already exist for this email; please contact the broker before trying again.';

export interface DemoRegistrationResponse extends AccountClassificationFields {
  access_token?: string;
  token?: string;
  refresh_token?: string;
  expires_at?: number | string;
  expires_in?: number;
  login?: number | string;
  account_login?: number | string;
  broker_id?: string;
  broker_name?: string;
  server?: string;
  group?: string;
  name?: string;
  username?: string;
  account_mode?: string;
}

const getStoredSessionBrokerId = (): string => {
  if (typeof window === 'undefined') return '';
  try {
    return String(window.localStorage.getItem('broker_id') || window.localStorage.getItem('rtx_broker_id') || '').trim();
  } catch {
    return '';
  }
};

interface DemoRegistrationTarget {
  configuration: ReturnType<typeof getRuntimeBrokerConfiguration>;
  desktop: boolean;
  brokerId: string;
  baseUrl: string;
}

const resolveDemoRegistrationTarget = (policyBrokerId?: string): DemoRegistrationTarget => {
  const configuration = getRuntimeBrokerConfiguration();
  const desktop = isDesktopBackendTarget();
  if (!desktop && !configuration.valid) {
    throw new Error('Demo registration is unavailable because this terminal has no valid broker configuration.');
  }
  const configuredBrokerId = configuration.brokerId;
  const sessionBrokerId = getStoredSessionBrokerId();
  const brokerId = String(desktop ? policyBrokerId || sessionBrokerId || configuredBrokerId : configuredBrokerId).trim();
  if (!brokerId) {
    throw new Error('Demo registration is unavailable because this terminal has no broker configured.');
  }
  const allowedBrokerIds = (desktop ? [sessionBrokerId, configuredBrokerId] : [configuredBrokerId])
    .map(value => value.trim()).filter(Boolean);
  if ((policyBrokerId && policyBrokerId.trim() !== brokerId)
    || (allowedBrokerIds.length && !allowedBrokerIds.includes(brokerId))) {
    throw new Error('Demo registration broker does not match this terminal deployment.');
  }
  return {
    configuration,
    desktop,
    brokerId,
    baseUrl: desktop ? API_V2_BASE_URL : `${toLocalDevProxyUrl(configuration.apiHostExt.replace(/\/+$/, ''))}/api/v2`,
  };
};

const normalizeAccountMode = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const apiErrorCode = (error: unknown): string => {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== 'object') return '';
  const data = error.data as Record<string, unknown>;
  for (const field of ['error', 'code', 'error_code']) {
    const value = data[field];
    if (typeof value === 'string' && value.trim()) return value.trim().toUpperCase();
  }
  return '';
};

/**
 * Reads which demo sign-up options the broker offers, from the same broker
 * API that registration uses. The netting option is offered only when the
 * broker says `demo_netting_registration_enabled: true`; anything else
 * (missing, not a boolean, another broker, an error) hides it.
 */
export const loadDemoRegistrationModes = async (
  policyBrokerId?: string,
  signal?: AbortSignal,
  desktopTarget?: DesktopDemoRegistrationTarget,
): Promise<DemoRegistrationModes> => {
  const closed: DemoRegistrationModes = { hedging: null, netting: false };
  let target: Pick<DemoRegistrationTarget, 'brokerId' | 'baseUrl'>;
  if (desktopTarget) {
    // Desktop: ask the connected broker at its directory address (see registerDesktopBrokerDemoAccount).
    const brokerId = String(desktopTarget.brokerId ?? '').trim();
    const origin = String(desktopTarget.serverUrl ?? '').trim().replace(/\/+$/, '');
    if (!isDesktopBackendTarget() || !brokerId || !/^https?:\/\//i.test(origin)) return closed;
    target = { brokerId, baseUrl: `${origin}/api/v2` };
  } else {
    try {
      target = resolveDemoRegistrationTarget(policyBrokerId);
    } catch {
      return closed;
    }
  }
  try {
    const config = await apiClient.get<Record<string, unknown>>('/broker/config', {
      baseUrl: target.baseUrl,
      skipDynamicUrl: true,
      skipAuth: true,
      params: { broker_id: target.brokerId },
      signal,
    });
    if (!config || typeof config !== 'object') return closed;
    const returnedBrokerId = typeof config.broker_id === 'string' ? config.broker_id.trim() : '';
    if (returnedBrokerId && returnedBrokerId !== target.brokerId) return closed;
    return {
      hedging: typeof config.demo_registration_enabled === 'boolean' ? config.demo_registration_enabled : null,
      netting: config.demo_netting_registration_enabled === true,
    };
  } catch {
    return closed;
  }
};

/** A desktop demo signup: the broker's Manager route also asks for a phone number. */
export interface DesktopDemoRegistrationInput {
  name: string;
  email: string;
  password: string;
  phone: string;
  /** Only 'netting' is sent; hedging keeps the admin's demo group and sends no mode. */
  accountMode?: DemoAccountMode;
}

/** The connected broker of a desktop demo signup and its directory server address. */
export interface DesktopDemoRegistrationTarget {
  brokerId: string;
  serverUrl: string;
}

export const DESKTOP_DEMO_NAME_MESSAGE = 'Please enter your first and last name.';
export const DESKTOP_DEMO_NO_LOGIN_MESSAGE = 'The broker did not return the new demo account login.';

/** Splits "First Middle Last" into the first word and the rest; null unless both parts are present. */
export const splitDemoAccountName = (fullName: string): { firstName: string; lastName: string } | null => {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
};

const readCreatedLogin = (created: unknown): number => {
  const record = created && typeof created === 'object' ? created as Record<string, unknown> : {};
  const login = Number(record.login ?? record.Login);
  return Number.isSafeInteger(login) && login > 0 ? login : 0;
};

/**
 * Opens a demo account from the desktop (TCP) terminal at the connected broker.
 *
 * The broker's Manager creates public demo accounts on its least-privilege
 * provisioning login, the same transaction path as an account the Manager opens
 * by hand (POST {origin}/api/v1/public/demo-account; the access server routes
 * /api/v1/public/* to the Manager). The Manager applies the admin's demo group
 * (its netting demo group for a netting request), leverage, currency and opening
 * balance; the caller cannot choose them. The new
 * account is then logged in through the ordinary trader login, so the session
 * is exactly the one a manual login would give.
 */
export const registerDesktopBrokerDemoAccount = async (
  input: DesktopDemoRegistrationInput,
  target: DesktopDemoRegistrationTarget,
): Promise<DemoRegistrationResponse> => {
  // The caller names the broker the TCP link is connected to and its
  // directory address (useDesktopDemoBroker); a saved session or the packaged
  // default broker does not decide where a desktop demo account is opened.
  if (!isDesktopBackendTarget()) throw new Error('Demo registration broker does not match this terminal deployment.');
  const brokerId = String(target?.brokerId ?? '').trim();
  const brokerOrigin = String(target?.serverUrl ?? '').trim().replace(/\/+$/, '');
  if (!brokerId || !/^https?:\/\//i.test(brokerOrigin)) {
    throw new Error('Demo registration is unavailable because this terminal has no broker configured.');
  }
  const names = splitDemoAccountName(input.name);
  if (!names) throw new Error(DESKTOP_DEMO_NAME_MESSAGE);
  const baseUrl = `${brokerOrigin}/api/v2`;
  const netting = input.accountMode === 'netting';

  let created: Record<string, unknown>;
  try {
    created = await apiClient.post<Record<string, unknown>>('/public/demo-account', {
      master_pass: input.password,
      email: input.email.trim(),
      first_name: names.firstName,
      last_name: names.lastName,
      phone: input.phone.trim(),
      // The Manager opens a netting request in the admin's netting demo group.
      ...(netting ? { account_mode: 'netting' } : {}),
    }, {
      baseUrl: `${brokerOrigin}/api/v1`,
      skipDynamicUrl: true,
      skipAuth: true,
    });
  } catch (error) {
    if (netting) {
      const code = apiErrorCode(error);
      if (code === 'DEMO_NETTING_NOT_CONFIGURED') throw new Error(DEMO_NETTING_NOT_CONFIGURED_MESSAGE);
      // A Manager without the netting demo group step answers a group/mode mismatch; nothing was created.
      if (code === 'ACCOUNT_MODE_GROUP_MISMATCH' || code === 'ACCOUNT_MODE_UNSUPPORTED') {
        throw new Error(DEMO_NETTING_UNAVAILABLE_MESSAGE);
      }
    }
    throw error;
  }
  const login = readCreatedLogin(created);
  if (!login) throw new Error(DESKTOP_DEMO_NO_LOGIN_MESSAGE);

  let session: Awaited<ReturnType<typeof authV2Api.login>>;
  try {
    session = await authV2Api.login({ username: String(login), password: input.password, broker_id: brokerId }, {
      baseUrl,
      skipDynamicUrl: true,
      persistSession: false,
    });
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` (${error.message})` : '';
    throw new Error(`Demo account ${login} was created, but logging in to it failed${reason}. Log in with account ${login} and the password you chose.`);
  }
  const token = session.access_token || session.token;
  if (!token) {
    throw new Error(`Demo account ${login} was created, but no trading session was returned. Log in with account ${login} and the password you chose.`);
  }
  if (session.broker_id && session.broker_id.trim() !== brokerId) {
    throw new Error('The demo account was returned for a different broker.');
  }
  return {
    ...session,
    access_token: token,
    token,
    account_login: session.account_login ?? login,
    broker_id: session.broker_id || brokerId,
    name: input.name.trim(),
  } as DemoRegistrationResponse;
};

/**
 * Registers against this terminal's broker. The caller cannot pass group: the
 * resolved broker and the backend's enabled default demo group are the
 * authority. Web registration always uses the deployment identity and API;
 * desktop registration can use the selected session broker.
 * A netting request names only the mode: the ADMIN-selected netting demo
 * group stays server-side, and the response must confirm netting.
 */
export const registerRuntimeBrokerDemoAccount = async (
  input: DemoRegistrationInput,
  policyBrokerId?: string,
): Promise<DemoRegistrationResponse> => {
  const { configuration, desktop, brokerId, baseUrl } = resolveDemoRegistrationTarget(policyBrokerId);
  const requestedMode: DemoAccountMode = input.accountMode === 'netting' ? 'netting' : 'hedging';

  let response: DemoRegistrationResponse;
  try {
    response = await apiClient.post<DemoRegistrationResponse>('/auth/register', {
      email: input.email.trim(),
      username: input.email.trim(),
      password: input.password,
      name: input.name.trim(),
      broker_id: brokerId,
      ...(requestedMode === 'netting' ? { account_mode: 'netting' } : {}),
    }, {
      baseUrl,
      skipDynamicUrl: true,
      skipAuth: true,
    });
  } catch (error) {
    const code = apiErrorCode(error);
    if (code === 'DEMO_NETTING_NOT_CONFIGURED') throw new Error(DEMO_NETTING_NOT_CONFIGURED_MESSAGE);
    if (code === 'DEMO_NETTING_UNAVAILABLE') throw new Error(DEMO_NETTING_UNAVAILABLE_MESSAGE);
    throw error;
  }

  if (!desktop && JSON.stringify(getRuntimeBrokerConfiguration()) !== JSON.stringify(configuration)) {
    throw new Error('The broker configuration changed during demo registration. Please log in manually.');
  }
  if (response.broker_id && response.broker_id.trim() !== brokerId) {
    throw new Error('The demo account was returned for a different broker.');
  }
  const returnedMode = normalizeAccountMode(response.account_mode);
  if (requestedMode === 'netting' ? returnedMode !== 'netting' : returnedMode === 'netting') {
    throw new Error(DEMO_ACCOUNT_MODE_MISMATCH_MESSAGE);
  }
  const token = response.access_token || response.token;
  const login = response.account_login ?? response.login;
  if (!token || !login) {
    throw new Error('Demo account was created without a usable trading session. Please log in manually.');
  }

  return {
    ...response,
    access_token: token,
    token,
    account_login: login,
    broker_id: response.broker_id || brokerId,
  };
};
