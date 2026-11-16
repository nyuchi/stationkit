import { INGEST_PATH } from "../ingest";
import type {
  IngestSetup,
  ReadingField,
  ReadingResult,
  StationSummary,
  StationType,
} from "./types";
import type { StoredStation } from "./store";

export interface ConsoleStation {
  stationId: string;
  name: string;
  stationType: StationType;
  /** `owner`: held by the signed-in person; `key`: browser-stored key only. */
  access: "owner" | "key";
  /** The saved key, if this browser has one. */
  key?: string | undefined;
}

/** Server list (owner-based) merged with this browser's saved keys. */
export function mergeStations(
  server: StationSummary[],
  local: StoredStation[],
): ConsoleStation[] {
  const keys = new Map(local.map((s) => [s.stationId, s.key]));
  const out: ConsoleStation[] = server.map((s) => ({
    stationId: s.stationId,
    name: s.name,
    stationType: s.stationType,
    access: "owner",
    key: keys.get(s.stationId),
  }));
  const owned = new Set(server.map((s) => s.stationId));
  for (const s of local) {
    if (!owned.has(s.stationId))
      out.push({
        stationId: s.stationId,
        name: s.name,
        stationType: s.stationType,
        access: "key",
        key: s.key,
      });
  }
  return out;
}

export interface SetupInstructions {
  host: string;
  path: string;
  wunderground: string;
  ecowitt: string;
}

/**
 * Setup text for station hardware. Where the Nyuchi API said where a station
 * uploads (its `ingest` field, at registration) that is what is shown, per
 * protocol. Where it said nothing (a rotated key) the console's configured
 * host and the path hardware already uses stand in.
 */
export function setupInstructions(
  fallbackHost: string,
  stationId: string,
  ingest?: IngestSetup | null,
): SetupInstructions {
  const wu = ingest?.wunderground ?? {
    server: fallbackHost,
    path: INGEST_PATH,
  };
  const ec = ingest?.ecowitt ?? { server: fallbackHost, path: INGEST_PATH };
  return {
    host: wu.server,
    path: wu.path,
    wunderground: `Wunderground protocol: server ${wu.server}, path ${wu.path}, ID = ${stationId}, PASSWORD = your ingest key`,
    ecowitt: `Ecowitt protocol: server ${ec.server}, path ${ec.path}, PASSKEY = ${stationId}:<your ingest key>`,
  };
}

/** "airTemperatureCelsius" -> "air temperature celsius" */
export function metricLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
}

export function formatMetrics(metrics: Record<string, number> | null): string {
  if (!metrics) return "";
  return Object.entries(metrics)
    .map(([k, v]) => `${metricLabel(k)}: ${v}`)
    .join(" · ");
}

export function describeLastReading(
  iso: string | null,
  locale?: string,
): string {
  if (!iso) return "No readings yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "No readings yet";
  return `Last reading ${d.toLocaleString(locale)}`;
}

/** What a person calls each reading field, for saying which one was refused. */
export const READING_FIELD_NAMES: Record<ReadingField, string> = {
  temperatureC: "temperature",
  rainfallMm: "rain",
  humidityPercent: "humidity",
  pressureHpa: "pressure",
  windKph: "wind",
};

/**
 * `measurements` is how many values the person entered. The API counts
 * readings, not measurements, and a manual reading is stored whole or not at
 * all, so the number shown is the one they typed.
 */
export function describeReadingResult(
  res: Pick<ReadingResult, "qcStatus"> &
    Partial<Pick<ReadingResult, "problems">>,
  measurements: number,
): string {
  if (res.qcStatus === "validated")
    return `Saved. ${measurements} measurement(s) accepted`;
  const reasons = [
    ...new Set(
      (res.problems ?? []).flatMap((p) =>
        p.field
          ? [
              `${READING_FIELD_NAMES[p.field]} ${
                p.code === "out_of_range"
                  ? "is out of range"
                  : "was not accepted"
              }`,
            ]
          : [],
      ),
    ),
  ];
  return reasons.length
    ? `Rejected by quality checks: ${reasons.join("; ")}`
    : "Rejected by quality checks";
}
