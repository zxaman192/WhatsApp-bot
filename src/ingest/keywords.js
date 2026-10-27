// Keyword sorter used when no AI key is set: guesses subject and topic for a question from its words.
// Rough by design; Claude does this properly when ANTHROPIC_API_KEY is set.
const MAP = {
  Anatomy: {
    'Upper Limb': ['brachial plexus', 'axillary', 'radial nerve', 'ulnar nerve', 'median nerve', 'rotator cuff', 'humerus', 'carpal'],
    'Lower Limb': ['femoral', 'sciatic', 'popliteal', 'tibial nerve', 'peroneal', 'gluteal', 'saphenous'],
    'Head And Neck': ['cranial nerve', 'parotid', 'larynx', 'pharyngeal', 'cavernous sinus', 'facial nerve', 'thyroid cartilage'],
    Thorax: ['mediastinum', 'pleura', 'bronchopulmonary', 'thoracic duct', 'intercostal'],
    Abdomen: ['inguinal canal', 'peritoneum', 'portal vein', 'celiac trunk', 'mesenteric artery'],
    Neuroanatomy: ['internal capsule', 'thalamus', 'cerebellum', 'basal ganglia', 'brainstem', 'circle of willis'],
    Embryology: ['pharyngeal arch', 'somite', 'neural crest', 'derivative of', 'develops from'],
    Histology: ['epithelium', 'histology', 'lining of'],
  },
  Physiology: {
    'Cardiovascular Physiology': ['cardiac output', 'stroke volume', 'baroreceptor', 'cardiac cycle', 'jvp wave'],
    'Respiratory Physiology': ['compliance', 'surfactant', 'tidal volume', 'oxygen dissociation', 'dead space'],
    'Renal Physiology': ['gfr', 'renal clearance', 'loop of henle', 'juxtaglomerular'],
    'Nerve And Muscle': ['action potential', 'resting membrane', 'neuromuscular junction', 'sarcomere'],
    Endocrine: ['hormone secretion', 'insulin secretion', 'feedback inhibition'],
  },
  Biochemistry: {
    'Carbohydrate Metabolism': ['glycolysis', 'gluconeogenesis', 'glycogen', 'pentose phosphate', 'hmp shunt'],
    'Lipid Metabolism': ['beta oxidation', 'ketone bodies', 'lipoprotein', 'cholesterol synthesis'],
    'Amino Acids': ['urea cycle', 'phenylketonuria', 'homocystinuria', 'alkaptonuria', 'amino acid'],
    Vitamins: ['vitamin', 'thiamine', 'niacin', 'pellagra', 'scurvy', 'riboflavin'],
    'Molecular Biology': ['dna replication', 'transcription', 'translation', 'pcr', 'codon', 'mutation'],
    Enzymes: ['enzyme', 'km value', 'competitive inhibition'],
  },
  Pathology: {
    Neoplasia: ['tumor suppressor', 'oncogene', 'carcinoma', 'neoplasm', 'metastasis', 'tumour marker'],
    Inflammation: ['inflammation', 'chemotaxis', 'granuloma', 'acute phase'],
    'Cell Injury': ['apoptosis', 'necrosis', 'cell injury', 'free radical'],
    Haematology: ['anemia', 'anaemia', 'leukemia', 'leukaemia', 'lymphoma', 'thalassemia', 'sickle cell', 'coagulation', 'platelet'],
    Amyloidosis: ['amyloid'],
    Genetics: ['karyotype', 'trisomy', 'turner syndrome', 'klinefelter'],
  },
  Pharmacology: {
    'Autonomic Nervous System': ['beta blocker', 'alpha blocker', 'atropine', 'cholinergic', 'adrenergic', 'neostigmine', 'propranolol', 'muscarinic'],
    Antimicrobials: ['antibiotic', 'penicillin', 'cephalosporin', 'aminoglycoside', 'vancomycin', 'antitubercular', 'isoniazid', 'rifampicin', 'antifungal', 'antiviral'],
    'CNS Drugs': ['antiepileptic', 'seizure', 'antipsychotic', 'antidepressant', 'benzodiazepine', 'opioid', 'morphine', 'levodopa'],
    'Cardiovascular Drugs': ['antihypertensive', 'ace inhibitor', 'digoxin', 'antiarrhythmic', 'statin', 'nitrate'],
    'Endocrine Drugs': ['insulin', 'sulfonylurea', 'metformin', 'corticosteroid', 'antithyroid', 'levothyroxine'],
    'Anticancer Drugs': ['anticancer', 'methotrexate', 'cisplatin', 'cyclophosphamide', 'vincristine'],
    Antidotes: ['antidote', 'poisoning treatment', 'overdose'],
    'General Pharmacology': ['bioavailability', 'half life', 'first pass', 'volume of distribution', 'drug of choice'],
    'Blood Drugs': ['heparin', 'warfarin', 'anticoagulant', 'antiplatelet', 'fibrinolytic'],
  },
  Microbiology: {
    Bacteriology: ['bacteria', 'staphylococcus', 'streptococcus', 'mycobacterium', 'clostridium', 'gram positive', 'gram negative', 'salmonella'],
    Virology: ['virus', 'hiv', 'hepatitis b', 'herpes', 'influenza', 'dengue'],
    Parasitology: ['plasmodium', 'malaria', 'helminth', 'entamoeba', 'giardia', 'taenia'],
    Mycology: ['fungus', 'fungal', 'candida', 'aspergillus', 'cryptococcus'],
    Immunology: ['immunoglobulin', 'hypersensitivity', 'complement', 'mhc', 'antibody', 'vaccine'],
  },
  'Forensic Medicine': {
    Toxicology: ['poison', 'arsenic', 'organophosphate', 'snake bite', 'dhatura', 'lead poisoning'],
    Thanatology: ['rigor mortis', 'postmortem', 'livor mortis', 'putrefaction', 'time since death'],
    'Injuries': ['abrasion', 'laceration', 'firearm', 'gunshot', 'bruise', 'hanging', 'strangulation', 'drowning'],
    'Legal Medicine': ['ipc', 'bns', 'dying declaration', 'inquest', 'consent', 'medical negligence'],
  },
  'Community Medicine': {
    Epidemiology: ['incidence', 'prevalence', 'cohort study', 'case control', 'screening test', 'sensitivity', 'specificity', 'attack rate'],
    Biostatistics: ['standard deviation', 'mean median', 'chi square', 'p value', 'confidence interval'],
    'Health Programmes': ['national programme', 'nhm', 'immunization schedule', 'janani', 'rntcp', 'ntep'],
    Nutrition: ['malnutrition', 'kwashiorkor', 'marasmus', 'iodine', 'balanced diet'],
    'Environmental Health': ['chlorination', 'water purification', 'noise', 'vector control'],
  },
  ENT: { Ear: ['otitis', 'cholesteatoma', 'tympanic', 'hearing loss', 'otosclerosis', 'vertigo'], 'Nose And Sinuses': ['epistaxis', 'sinusitis', 'nasal polyp', 'septum'], Larynx: ['vocal cord', 'laryngeal', 'stridor', 'tonsil'] },
  Ophthalmology: { Lens: ['cataract'], Glaucoma: ['glaucoma', 'intraocular pressure'], Retina: ['retina', 'retinal detachment', 'diabetic retinopathy', 'macula'], Cornea: ['cornea', 'keratitis', 'corneal ulcer'], Uvea: ['uveitis', 'iritis'], 'Neuro-Ophthalmology': ['optic nerve', 'papilledema', 'visual field'] },
  Medicine: {
    Cardiology: ['myocardial infarction', 'heart failure', 'murmur', 'ecg', 'endocarditis', 'atrial fibrillation'],
    Neurology: ['stroke', 'meningitis', 'parkinson', 'multiple sclerosis', 'myasthenia'],
    Nephrology: ['nephrotic', 'nephritic', 'renal failure', 'dialysis'],
    Endocrinology: ['diabetes', 'thyroid storm', 'hypothyroidism', 'cushing', 'addison', 'hyperthyroidism'],
    Gastroenterology: ['cirrhosis', 'hepatitis', 'pancreatitis', 'crohn', 'ulcerative colitis'],
    Pulmonology: ['asthma', 'copd', 'pneumonia', 'tuberculosis', 'ards'],
    Rheumatology: ['rheumatoid', 'lupus', 'sle', 'gout', 'vasculitis'],
  },
  Surgery: {
    'Trauma': ['trauma', 'atls', 'burns', 'head injury'],
    'GI Surgery': ['appendicitis', 'hernia', 'intestinal obstruction', 'cholecystitis', 'gallstone'],
    Breast: ['breast', 'fibroadenoma', 'mastectomy'],
    'Thyroid And Endocrine Surgery': ['thyroidectomy', 'parathyroid', 'thyroid nodule'],
    Urology: ['renal calculi', 'hydronephrosis', 'bph', 'prostate'],
    Vascular: ['varicose', 'aneurysm', 'peripheral arterial'],
  },
  'Obstetrics & Gynaecology': {
    Obstetrics: ['pregnancy', 'gestation', 'labour', 'labor', 'preeclampsia', 'postpartum', 'placenta', 'fetal', 'antenatal'],
    Gynaecology: ['menstrual', 'amenorrhea', 'endometriosis', 'fibroid', 'ovarian', 'cervical cancer', 'pcos', 'contraceptive'],
  },
  Paediatrics: {
    Neonatology: ['neonate', 'newborn', 'neonatal', 'apgar', 'preterm'],
    'Growth And Development': ['milestone', 'growth chart', 'development'],
    'Paediatric Infections': ['measles', 'diphtheria', 'pertussis', 'mumps'],
    'Congenital Disorders': ['congenital', 'down syndrome', 'tetralogy'],
  },
  Orthopaedics: { Fractures: ['fracture', 'dislocation', 'colles', 'scaphoid'], 'Bone Tumours': ['osteosarcoma', 'ewing', 'giant cell tumor'], Infections: ['osteomyelitis', 'septic arthritis'], 'Peripheral Nerve Injuries': ['wrist drop', 'foot drop', 'claw hand'] },
  Dermatology: { 'Papulosquamous Disorders': ['psoriasis', 'lichen planus'], 'Vesiculobullous Disorders': ['pemphigus', 'pemphigoid'], Leprosy: ['leprosy', 'hansen'], 'Infections': ['scabies', 'tinea', 'impetigo'] },
  Psychiatry: { 'Mood Disorders': ['depression', 'bipolar', 'mania'], Schizophrenia: ['schizophrenia', 'delusion', 'hallucination'], 'Substance Use': ['alcohol withdrawal', 'delirium tremens', 'opioid withdrawal'], 'Anxiety Disorders': ['anxiety', 'ocd', 'phobia', 'panic'] },
  Anaesthesia: { 'Anaesthetic Agents': ['anaesthetic agent', 'anesthetic', 'propofol', 'ketamine', 'halothane', 'sevoflurane', 'thiopentone'], 'Muscle Relaxants': ['succinylcholine', 'suxamethonium', 'muscle relaxant', 'vecuronium'], 'Local Anaesthetics': ['lignocaine', 'lidocaine', 'bupivacaine', 'spinal anaesthesia'], Airway: ['intubation', 'laryngoscope', 'airway'] },
  Radiology: { 'Imaging Signs': ['x-ray', 'xray', 'ct scan', 'mri', 'ultrasound', 'radiograph', 'sign on'], 'Radiation Physics': ['radiation', 'radioisotope', 'half value'] },
};

/** Best-guess { subject, topic } for a piece of text, or null if nothing matches. */
export function classify(text) {
  const t = ' ' + String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ') + ' ';
  let best = null;
  for (const [subject, topics] of Object.entries(MAP)) {
    for (const [topic, words] of Object.entries(topics)) {
      let score = 0;
      for (const w of words) if (t.includes(' ' + w)) score += w.includes(' ') ? 2 : 1;
      if (score && (!best || score > best.score)) best = { subject, topic, score };
    }
  }
  return best && { subject: best.subject, topic: best.topic };
}
