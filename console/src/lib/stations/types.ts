/**
 * The console's view of a station. A station is a device (device.devices,
 * category weather_station) held by the Nyuchi API; these types are the BFF
 * contract the browser sees, independent of which client serves them.
 */

export type StationType = "digital" | "manual";

export interface RegisterInput {
  name: string;
  lat: number;
  lon: number;
  stationType: StationType;
  /** ISO 3166-1 alpha-2, upper case. Sent on every registration: the API files an omitted one under ZW. */
  country: string;
  hardware?: string;
}

/** Where one hardware protocol uploads, as the API told us at registration. */
export interface IngestHint {
  server: string;
  path: string;
}

/** The API's `ingest` field: the upload target per protocol. */
export interface IngestSetup {
  wunderground: IngestHint;
  ecowitt: IngestHint;
}

/** Returned once, at registration or key rotation. */
export interface IssuedCredentials {
  stationId: string;
  ingestKey: string;
  /**
   * Set at registration, from the API. Absent when the API sent none (key
   * rotation answers none), and then the console shows its configured host.
   */
  ingest?: IngestSetup | undefined;
}

export interface RegisteredStation extends IssuedCredentials {
  name: string;
  stationType: StationType;
}

/** A station as listed for its owner: never carries the key. */
export interface StationSummary {
  stationId: string;
  name: string;
  stationType: StationType;
  status: string;
  lastObservationAt: string | null;
}

export interface StationStatus extends StationSummary {
  latestMetrics: Record<string, number> | null;
}

export const READING_FIELDS = [
  "temperatureC",
  "rainfallMm",
  "humidityPercent",
  "pressureHpa",
  "windKph",
] as const;

export type ReadingField = (typeof READING_FIELDS)[number];
export type ReadingInput = Partial<Record<ReadingField, number>>;

/** Why a reading was refused: the field and a code, never the value. */
export interface ReadingProblem {
  field: ReadingField | null;
  code: string;
}

export interface ReadingResult {
  /** Readings stored (or stored before: a retry). Not a count of measurements. */
  accepted: number;
  rejected: number;
  qcStatus: "validated" | "rejected";
  problems: ReadingProblem[];
}

/** Who is calling the BFF: always derived from the server-side session. */
export interface Caller {
  personId: string;
  email: string;
  /** WorkOS access token; exchanged for an API token, never sent to the browser. */
  accessToken?: string | undefined;
}

/** Set when a legacy (key-only) station is addressed without an owner. */
export interface KeyAuth {
  stationKey?: string | undefined;
}

export class StationsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StationsApiError";
    this.status = status;
  }
}

export interface StationsClient {
  register(
    caller: Caller,
    input: RegisterInput,
  ): Promise<IssuedCredentials & { stationType: StationType }>;
  list(caller: Caller): Promise<StationSummary[]>;
  status(
    caller: Caller,
    stationId: string,
    auth?: KeyAuth,
  ): Promise<StationStatus>;
  submitReading(
    caller: Caller,
    stationId: string,
    reading: ReadingInput,
    auth?: KeyAuth,
  ): Promise<ReadingResult>;
  rotateKey(caller: Caller, stationId: string): Promise<IssuedCredentials>;
  /** Take over a legacy (community) station by proving the station's key. */
  claim(
    caller: Caller,
    stationId: string,
    auth: KeyAuth,
  ): Promise<StationSummary>;
}
