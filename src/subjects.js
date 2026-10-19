// The 19 NEET PG subjects. Every question and note is filed under exactly one of these.
export const SUBJECTS = [
  'Anatomy',
  'Physiology',
  'Biochemistry',
  'Pathology',
  'Pharmacology',
  'Microbiology',
  'Forensic Medicine',
  'Community Medicine',
  'ENT',
  'Ophthalmology',
  'Medicine',
  'Surgery',
  'Obstetrics & Gynaecology',
  'Paediatrics',
  'Orthopaedics',
  'Dermatology',
  'Psychiatry',
  'Anaesthesia',
  'Radiology',
];

const ALIASES = {
  anat: 'Anatomy',
  physio: 'Physiology',
  biochem: 'Biochemistry',
  bio: 'Biochemistry',
  patho: 'Pathology',
  path: 'Pathology',
  pharma: 'Pharmacology',
  pharm: 'Pharmacology',
  micro: 'Microbiology',
  fmt: 'Forensic Medicine',
  forensic: 'Forensic Medicine',
  psm: 'Community Medicine',
  spm: 'Community Medicine',
  community: 'Community Medicine',
  ent: 'ENT',
  optha: 'Ophthalmology',
  ophtha: 'Ophthalmology',
  eye: 'Ophthalmology',
  med: 'Medicine',
  medicine: 'Medicine',
  surg: 'Surgery',
  surgery: 'Surgery',
  obg: 'Obstetrics & Gynaecology',
  obgy: 'Obstetrics & Gynaecology',
  gyn: 'Obstetrics & Gynaecology',
  gynae: 'Obstetrics & Gynaecology',
  obs: 'Obstetrics & Gynaecology',
  peds: 'Paediatrics',
  paeds: 'Paediatrics',
  pediatrics: 'Paediatrics',
  ortho: 'Orthopaedics',
  derma: 'Dermatology',
  derm: 'Dermatology',
  skin: 'Dermatology',
  psych: 'Psychiatry',
  psychiatry: 'Psychiatry',
  anaes: 'Anaesthesia',
  anesthesia: 'Anaesthesia',
  radio: 'Radiology',
  radiology: 'Radiology',
};

/** Turn a loose word like "pharma" or "obg" into a canonical subject name, or null. */
export function matchSubject(word) {
  if (!word) return null;
  const w = word.toLowerCase().replace(/[^a-z&]/g, '');
  if (!w) return null;
  if (ALIASES[w]) return ALIASES[w];
  const exact = SUBJECTS.find((s) => s.toLowerCase().replace(/[^a-z&]/g, '') === w);
  if (exact) return exact;
  if (w.length >= 4) {
    const prefix = SUBJECTS.find((s) => s.toLowerCase().startsWith(w));
    if (prefix) return prefix;
  }
  return null;
}

/** Find the first subject mentioned anywhere in a free-text string (e.g. a file caption). */
export function findSubjectIn(text) {
  if (!text) return null;
  for (const token of text.split(/[\s,._\-/]+/)) {
    const s = matchSubject(token);
    if (s) return s;
  }
  return null;
}
