/**
 * Well-known test Stellar addresses used across all test suites.
 * Using consistent addresses helps identify roles in test scenarios.
 */

export const TEST_ADDRESSES = {
  /** Market creator, admin operations */
  CREATOR: "GDXTYTUAMJQMN7FS5UX2E7KR75VXLUQ36P3ZDJNIAQOSYAMMCIGUNIOA",
  
  /** Primary bettor for most test scenarios */
  BETTOR: "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE",
  
  /** Secondary bettor for multi-user scenarios */
  BETTOR_2: "GCCP3F4XDN7TNFF7S3EVHLUW6CM2CR2EDMU6UIB4DR3Z4BGCIBTUSHV6",
  
  /** Oracle submission and finalization */
  ORACLE_SUBMITTER: "GB72IPHJQ3ATBV7NQHUR26QS6LIMTGALB6CPNEF7ZALNUS5VG2GMXNO2",
  
  /** Oracle challenger */
  ORACLE_CHALLENGER: "GAYBXPLPKV4IQVSBJMUMYHYVZHQW2ECQDSMFB7WEMWXP3JPH5SECHPXE",
  
  /** Referrer for referral tests */
  REFERRER: "GCCP3F4XDN7TNFF7S3EVHLUW6CM2CR2EDMU6UIB4DR3Z4BGCIBTUSHV6",
  
  /** Referee (referred user) */
  REFEREE: "GAQ5DISJPXUYYT2ZWNPAUDPNJXTVZMDLX6VPQB6PPWTKZXDEB6OH5KLC",
  
  /** Token mint recipient */
  TOKEN_RECIPIENT: "GD6Y22EG4PGE3SVRO3BMK5PKAVHVZNEP2G6O3WPSQ3KI2TY3H2EDWNVT",
} as const;

/** Default Stellar G-address pattern for generated addresses */
export function generateAddress(seed: string): string {
  const hash = Array.from(seed).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let address = "G";
  for (let i = 0; i < 55; i++) {
    address += base32Chars[(hash + i) % base32Chars.length];
  }
  return address;
}
