/**
 * ISO 3166-1 alpha-2 codes. A station is filed under the country it was
 * registered with, and the Nyuchi API files an omitted one under ZW, so the
 * console asks for it and never guesses. The names come from the runtime's
 * `Intl.DisplayNames`, so no table of names is kept here.
 */
const CODES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ
EC EE EG EH ER ES ET
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ
VA VC VE VG VI VN VU
WF WS
YE YT
ZA ZM ZW
`;

export const COUNTRY_CODES: readonly string[] = CODES.trim().split(/\s+/);

const KNOWN = new Set(COUNTRY_CODES);

/** The upper-case code if `value` is a known ISO 3166-1 alpha-2 code, else null. */
export function parseCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return KNOWN.has(code) ? code : null;
}

export interface CountryOption {
  value: string;
  label: string;
}

const memo = new Map<string, CountryOption[]>();

/** Every country, by name, for the register form's select. */
export function countryOptions(locale = "en"): CountryOption[] {
  const known = memo.get(locale);
  if (known) return known;
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    // No region names in this runtime: the code stands in for the name.
  }
  const options = COUNTRY_CODES.map((value) => ({
    value,
    label: names?.of(value) ?? value,
  })).sort((a, b) => a.label.localeCompare(b.label, locale));
  memo.set(locale, options);
  return options;
}
