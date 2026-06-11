// Named Hebrew code points — letters, nekudot (vowel points), and te'amim (cantillation marks).
// The DB worker registers each as a 0-arity SQL function (e.g. PAZER() → '֡', ALEPH() → 'א') and exposes
// them to evalJS as an `H` object, so queries can say replace(text, PAZER(), '') instead of char(1441).

export const HEBREW_CHARS: Record<string, number> = {
  // --- letters (incl. final forms) ---
  ALEPH: 0x05d0, BET: 0x05d1, GIMEL: 0x05d2, DALET: 0x05d3, HE: 0x05d4, VAV: 0x05d5, ZAYIN: 0x05d6,
  HET: 0x05d7, TET: 0x05d8, YOD: 0x05d9, KAF: 0x05db, FINAL_KAF: 0x05da, LAMED: 0x05dc,
  MEM: 0x05de, FINAL_MEM: 0x05dd, NUN: 0x05e0, FINAL_NUN: 0x05df, SAMEKH: 0x05e1, AYIN: 0x05e2,
  PE: 0x05e4, FINAL_PE: 0x05e3, TSADI: 0x05e6, FINAL_TSADI: 0x05e5, QOF: 0x05e7, RESH: 0x05e8,
  SHIN: 0x05e9, TAV: 0x05ea,

  // --- nekudot (vowel points) + dagesh/marks ---
  SHEVA: 0x05b0, HATAF_SEGOL: 0x05b1, HATAF_PATAH: 0x05b2, HATAF_QAMATS: 0x05b3, HIRIQ: 0x05b4,
  TSERE: 0x05b5, SEGOL: 0x05b6, PATAH: 0x05b7, QAMATS: 0x05b8, HOLAM: 0x05b9, HOLAM_HASER: 0x05ba,
  QUBUTS: 0x05bb, DAGESH: 0x05bc, METEG: 0x05bd, MAQAF: 0x05be, RAFE: 0x05bf, PASEQ: 0x05c0,
  SHIN_DOT: 0x05c1, SIN_DOT: 0x05c2, SOF_PASUQ: 0x05c3, QAMATS_QATAN: 0x05c7,

  // --- te'amim (cantillation) ---
  ETNAHTA: 0x0591, SEGOLTA: 0x0592, SHALSHELET: 0x0593, ZAQEF_QATAN: 0x0594, ZAQEF_GADOL: 0x0595,
  TIPEHA: 0x0596, REVIA: 0x0597, ZARQA: 0x0598, PASHTA: 0x0599, YETIV: 0x059a, TEVIR: 0x059b,
  GERESH: 0x059c, GERESH_MUQDAM: 0x059d, GERSHAYIM: 0x059e, QARNEY_PARA: 0x059f, TELISHA_GEDOLA: 0x05a0,
  PAZER: 0x05a1, ATNAH_HAFUKH: 0x05a2, MUNAH: 0x05a3, MAHAPAKH: 0x05a4, MERKHA: 0x05a5,
  MERKHA_KEFULA: 0x05a6, DARGA: 0x05a7, QADMA: 0x05a8, TELISHA_QETANA: 0x05a9, YERAH_BEN_YOMO: 0x05aa,
  OLE: 0x05ab, ILUY: 0x05ac, DEHI: 0x05ad, ZINOR: 0x05ae,
};

/** Name → the actual character (string), e.g. PAZER → '֡'. */
export const HEBREW_CHAR_STRINGS: Record<string, string> = Object.fromEntries(
  Object.entries(HEBREW_CHARS).map(([name, cp]) => [name, String.fromCodePoint(cp)])
);

export const HEBREW_CHAR_NAMES = Object.keys(HEBREW_CHARS);
