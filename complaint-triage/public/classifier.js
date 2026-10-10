/*
 * On-device complaint triage engine for PS-07 "Every Complaint Heard".
 * Pure JS, no network, no dependencies. Works in the browser and in Node (for tests).
 *
 *   detectLanguage(text)  -> 'en' | 'gu' | 'hi' | 'gu-Latn' (Gujlish) | 'hi-Latn' (Hinglish)
 *   classify(text, opts)  -> { dept, secondary, confidence, deptScores, station, urgency, level, signals, lang }
 *   draftReply(c, lang)   -> reply text in the complainant's language/script
 */
(function (root) {
  'use strict';

  // ---------- Departments ----------
  const DEPARTMENTS = {
    safety:      { label: 'Safety & Security',    base: 35 },
    lifts:       { label: 'Lifts & Escalators',   base: 22 },
    fare:        { label: 'Fare & Ticketing',     base: 20 },
    staff:       { label: 'Staff Behaviour',      base: 15 },
    cleanliness: { label: 'Cleanliness',          base: 15 },
    general:     { label: 'General / Other',      base: 8 },
  };
  const DEPT_ORDER = ['safety', 'lifts', 'fare', 'staff', 'cleanliness', 'general'];

  const LANGS = {
    'en':      'English',
    'gu':      'ગુજરાતી',
    'hi':      'हिन्दी',
    'gu-Latn': 'Gujlish',
    'hi-Latn': 'Hinglish',
  };

  // ---------- Matching helpers ----------
  // '=word' means whole-word match; otherwise Latin terms are prefix-matched at a word start.
  // Non-Latin (Gujarati / Devanagari) terms are substring-matched, since \b does not work on Indic scripts.
  function makeMatcher(term) {
    const exact = term.startsWith('=');
    const t = (exact ? term.slice(1) : term).toLowerCase();
    if (/[^\x00-\x7F]/.test(t)) return (s) => s.includes(t);
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^a-z0-9])' + esc + (exact ? '(?=$|[^a-z0-9])' : ''));
    return (s) => re.test(s);
  }
  function compile(list) {
    return list.map((x) => (typeof x === 'string' ? { t: x, w: 1 } : x)).map((x) => ({ ...x, m: makeMatcher(x.t) }));
  }
  function normalize(text) {
    return String(text || '').normalize('NFC').toLowerCase();
  }

  // ---------- Department lexicons (English, Gujlish/Hinglish, Gujarati, Hindi) ----------
  const W2 = (t) => ({ t, w: 2 });
  const H = (t) => ({ t, w: 0.5 });
  const LEXICON = {
    safety: compile([
      // English
      W2('fire'), W2('smoke'), W2('harass'), W2('molest'), W2('eve teas'), 'touch', 'unsafe', 'danger', W2('injur'), 'hurt',
      '=fell', '=fall', 'slip', W2('blood'), W2('unconscious'), W2('faint'), 'fight', 'theft', 'stole', 'pickpocket',
      W2('unattended'), W2('suspicious'), W2('bomb'), W2('weapon'), W2('knife'), 'emergency', 'attack', 'drunk',
      'stampede', 'spark', 'electric shock', 'short circuit', 'ladies coach', 'women coach',
      // Romanized
      W2('aag'), W2('dhuan'), W2('dhuaan'), W2('dhuvo'), W2('chhed'), W2('ched'), W2('heran'), '=chot', 'ijaa',
      'gir gay', 'gir pad', 'padi gay', 'padi gai', 'padya', W2('lohi'), W2('khoon'), W2('behosh'), W2('chakkar'),
      'ladai', 'jhagd', 'chori', W2('lawaris'), W2('laavaris'), 'khatarnak', 'khatra', 'lapas', 'phisal',
      // Gujarati
      W2('આગ'), W2('ધુમાડ'), W2('હેરાન'), W2('છેડ'), W2('ઈજા'), W2('ઇજા'), 'પડી', 'પડ્યા', W2('લોહી'), W2('બેભાન'),
      W2('ચક્કર'), 'ઝઘડ', 'ચોરી', 'લપસ', 'ખતર', 'અસુરક્ષિત', W2('શંકાસ્પદ'), W2('બિનવારસી'), 'મહિલા',
      // Hindi
      W2('आग'), W2('धुआ'), W2('धुंआ'), W2('छेड़'), W2('छेड'), 'परेशान', W2('चोट'), 'गिर', W2('खून'), W2('बेहोश'),
      W2('चक्कर'), 'लड़ाई', 'झगड़', 'चोरी', W2('लावारिस'), 'फिसल', 'खतर', 'ख़तर', 'असुरक्षित', W2('संदिग्ध'), 'महिला',
    ]),
    cleanliness: compile([
      'dirty', 'filth', 'clean', 'garbage', 'trash', 'dustbin', 'litter', 'smell', 'stink', 'odour', 'odor', 'toilet',
      'washroom', 'restroom', 'urine', 'vomit', 'spill', 'stain', 'cockroach', '=rat', '=rats', 'pest', 'drinking water',
      'hygien', 'mess', 'spit', 'paan', 'gutkha',
      'ganda', 'gandi', 'gandki', 'gandagi', 'safai', 'kachra', 'kachro', '=vaas', 'badbu', 'bharela', 'sauchalay',
      'ગંદ', 'સફાઈ', 'કચર', 'ટોઇલેટ', 'ટોયલેટ', 'શૌચાલય', 'દુર્ગંધ', 'ગંધ', 'થૂંક', H('પાણી'),
      'गंद', 'सफाई', 'सफ़ाई', 'कचरा', 'शौचालय', 'टॉयलेट', 'बदबू', 'थूक', H('पानी'),
    ]),
    fare: compile([
      'fare', 'ticket', 'refund', 'charged', 'charge', 'deduct', 'money', '=card', 'recharge', 'balance', '=qr', 'token',
      'payment', '=upi', 'transaction', '=txn', 'overcharg', 'price', 'vending', '=tvm', 'machine', H('=gate'), H('=gates'),
      'paisa', 'paise', 'bhadu', 'kiraya', 'kat gay', 'kapai', 'kapay',
      'ટિકિટ', 'ભાડ', 'રિફંડ', 'પૈસા', 'કાર્ડ', 'રિચાર્જ', 'સ્કેન', 'બેલેન્સ', 'કપાઈ', 'કપાય', H('ગેટ'),
      'टिकट', 'किराया', 'किराए', 'रिफंड', 'पैसे', 'पैसा', 'कार्ड', 'रिचार्ज', 'मशीन', 'बैलेंस', 'स्कैन', H('गेट'),
    ]),
    lifts: compile([
      'lift', 'elevator', 'escalator', 'stair', H('wheelchair'), 'ramp', 'grinding', H('stuck'), H('trapped'),
      'fanse', 'phanse', 'fasai', 'fasaya',
      'લિફ્ટ', 'એસ્કેલેટર', 'એલિવેટર', 'સીડી', 'ફસા',
      'लिफ्ट', 'लिफ़्ट', 'एस्केलेटर', 'एस्कलेटर', 'सीढ़ी', 'फंस', 'फँस',
    ]),
    staff: compile([
      'staff', '=rude', 'behav', 'misbehav', 'shout', 'abus', 'guard', 'employee', 'attendant', 'officer', 'counter',
      'unprofessional', 'ignor', 'refused', 'arrogant', 'insult', 'bribe', 'did not help', "didn't help", 'no help',
      'busy on', 'on his phone', 'on her phone',
      'badtameez', 'badtamiz', 'chilla', 'buri tarah', 'vartan', 'madad na', 'madad nahi', 'madad j na', '=uddhat',
      'સ્ટાફ', 'કર્મચારી', 'ગાર્ડ', 'ઉદ્ધત', 'અપમાન', 'બૂમ', 'ગેરવર્તન', 'વર્તન', 'મદદ ન',
      'स्टाफ', 'स्टाफ़', 'कर्मचारी', 'गार्ड', 'बदतमीज़', 'बदतमीज', 'चिल्ला', 'दुर्व्यवहार', 'व्यवहार', 'कुछ नहीं कहा', 'मदद नहीं',
    ]),
    general: compile([
      '=ac', 'air condition', 'delay', '=late', 'frequency', 'wifi', 'parking', '=auto', 'autowala', 'rickshaw',
      'announcement', 'display', 'signage', 'crowd', 'garmi', 'bheed', 'bhid',
      'ગરમી', 'ભીડ', 'પાર્કિંગ', 'રિક્ષા', 'મોડું', 'મોડી',
      'गर्मी', 'भीड़', 'पार्किंग', 'रिक्शा', 'देरी', 'लेट',
    ]),
  };

  // ---------- Urgency signals (each counted once) ----------
  const SIGNALS = [
    { id: 'fire', pts: 45, label: 'Fire / smoke / electrical hazard',
      terms: ['fire', 'smoke', 'spark', 'short circuit', 'electric shock', 'aag', 'dhuan', 'dhuaan', 'dhuvo', 'આગ', 'ધુમાડ', 'आग', 'धुआ', 'धुंआ'] },
    { id: 'harassment', pts: 45, label: 'Harassment / personal safety',
      terms: ['harass', 'molest', 'eve teas', 'groped', 'chhed', 'heran', 'હેરાન', 'છેડ', 'छेड़', 'छेड'] },
    { id: 'security', pts: 45, label: 'Suspicious object / security threat',
      terms: ['unattended', 'suspicious', 'bomb', 'weapon', 'knife', 'lawaris', 'laavaris', 'બિનવારસી', 'શંકાસ્પદ', 'लावारिस', 'संदिग्ध'] },
    { id: 'medical', pts: 40, label: 'Injury / medical emergency',
      terms: ['injur', 'blood', 'unconscious', 'faint', '=fell', 'collapsed', 'chakkar', 'behosh', 'khoon', 'lohi', 'padi gay', 'padi gai', 'gir gay',
              'બેભાન', 'લોહી', 'ચક્કર', 'ઈજા', 'ઇજા', 'પડી ગ', 'बेहोश', 'खून', 'चोट', 'गिर गय', 'चक्कर'] },
    { id: 'trapped', pts: 45, label: 'Passenger trapped',
      terms: ['stuck', 'trapped', 'fanse', 'phanse', 'fasai', 'fasaya', 'ફસા', 'फंस', 'फँस'] },
    { id: 'hazard', pts: 20, label: 'Slip / crowd / mechanical hazard',
      terms: ['slip', 'leak', 'stampede', 'jerk', 'could fall', 'may fall', 'lapas', 'phisal', 'લપસ', 'આંચકા', 'પડી શકે', 'फिसल', 'झटक'] },
    { id: 'vulnerable', pts: 10, label: 'Vulnerable passenger involved',
      terms: ['child', '=kid', 'baby', 'elderly', 'old lady', 'old man', 'senior', 'wheelchair', 'pregnant', 'disabled', 'blind',
              '=women', '=woman', '=lady', 'ladies', 'my father', 'my mother', 'buzurg', 'bachcha', 'bachchu', 'baalak', 'vruddh',
              'બાળક', 'વૃદ્ધ', 'વડીલ', 'મહિલા', 'ગર્ભવતી', 'વ્હીલચેર', 'बच्चा', 'बच्चे', 'बुजुर्ग', 'बुज़ुर्ग', 'महिला', 'गर्भवती', 'व्हीलचेयर'] },
    { id: 'immediacy', pts: 10, label: 'Ongoing — needs immediate action',
      terms: ['immediately', 'urgent', '=asap', 'right now', 'jaldi', 'turant', 'tatkal', '=abhi', 'hamna', 'please help', 'help!',
              'તાત્કાલિક', 'હમણાં', 'જલ્દી', 'तुरंत', 'जल्दी', 'अभी'] },
    { id: 'persistence', pts: 8, label: 'Recurring / long-standing issue',
      terms: ['=days', '=week', 'weeks', 'daily', 'every day', 'again', 'still', 'divas', 'hafte', 'hafta', '=roz', 'roj', 'darroj',
              'દિવસ', 'દરરોજ', 'રોજ', 'અઠવાડ', 'दिन से', 'रोज़', 'रोज', 'हफ्त', 'हफ़्त'] },
    { id: 'outOfService', pts: 12, label: 'Accessibility asset out of service', onlyFor: 'lifts',
      terms: ['=band', 'bandh', 'not working', 'stopped', 'broken', 'out of order', 'kaam nahi', 'kaam nathi', 'બંધ', 'बंद', 'खराब', 'ખરાબ'] },
    { id: 'moneyLost', pts: 15, label: 'Money deducted — refund owed', onlyFor: 'fare',
      terms: ['deduct', 'charged twice', 'double charg', 'not updated', 'kat gay', 'kapai', 'કપાઈ', 'કપાય', 'काट', 'कट गए', 'कटे'] },
    { id: 'amenity', pts: 20, label: 'Basic amenity (toilet / drinking water)', onlyFor: 'cleanliness',
      terms: ['toilet', 'washroom', 'drinking water', 'sauchalay', 'ટોઇલેટ', 'ટોયલેટ', 'શૌચાલય', 'પાણી', 'शौचालय', 'टॉयलेट', 'पानी'] },
  ].map((s) => ({ ...s, m: s.terms.map(makeMatcher) }));

  const CHANNEL_BONUS = { social: { pts: 8, label: 'Public social-media post — reputational risk' } };

  // ---------- Stations (Ahmedabad–Gandhinagar Metro) with Gujarati / Hindi aliases ----------
  const STATIONS = [
    ['Thaltej Gam', 'થલતેજ ગામ'], ['Thaltej', 'થલતેજ', 'थलतेज'], ['Doordarshan Kendra', 'દૂરદર્શન કેન્દ્ર', 'दूरदर्शन केंद्र'],
    ['Gurukul Road', 'ગુરુકુળ રોડ', 'गुरुकुल रोड'], ['Gujarat University', 'ગુજરાત યુનિવર્સિટી', 'गुजरात यूनिवर्सिटी'],
    ['Commerce Six Road', 'Commerce Six Roads', 'કોમર્સ છ રસ્તા'], ['Old High Court', 'જૂની હાઈકોર્ટ', 'ओल्ड हाई कोर्ट'],
    ['Shahpur', 'શાહપુર', 'शाहपुर'], ['Ghee Kanta', 'ઘી કાંટા', 'घी कांटा'],
    ['Kalupur Railway Station', 'Kalupur', 'કાલુપુર', 'कालूपुर', 'कालुपुर'], ['Kankaria East', 'Kankaria', 'કાંકરિયા', 'कांकरिया'],
    ['Apparel Park', 'એપેરલ પાર્ક'], ['Amraiwadi', 'અમરાઈવાડી', 'अमराईवाडी'], ['Rabari Colony', 'રબારી કોલોની'],
    ['Vastral Gam', 'વસ્ત્રાલ ગામ'], ['Vastral', 'વસ્ત્રાલ', 'वस्त्राल'], ['Nirant Cross Road', 'Nirant', 'નિરાંત'],
    ['APMC', 'એપીએમસી'], ['Jivraj Park', 'જીવરાજ પાર્ક', 'जीवराज पार्क'], ['Rajivnagar', 'રાજીવનગર'], ['Shreyas', 'શ્રેયસ'],
    ['Paldi', 'પાલડી', 'पालडी', 'पालड़ी'], ['Gandhigram', 'ગાંધીગ્રામ', 'गांधीग्राम'], ['Usmanpura', 'ઉસ્માનપુરા'],
    ['Vijaynagar', 'Vijay Nagar', 'વિજયનગર', 'विजयनगर'], ['Vadaj', 'વાડજ', 'वाडज'], ['Ranip', 'રાણીપ', 'राणीप', 'रानीप'],
    ['Sabarmati', 'સાબરમતી', 'साबरमती'], ['Motera Stadium', 'Motera', 'મોટેરા', 'मोटेरा'], ['Stadium', 'સ્ટેડિયમ', 'स्टेडियम'],
    ['GNLU', 'જીએનએલયુ'], ['GIFT City', 'ગિફ્ટ સિટી'], ['Mahatma Mandir', 'મહાત્મા મંદિર'], ['Sachivalaya', 'સચિવાલય'], ['Infocity', 'ઇન્ફોસિટી'],
  ];
  const STATION_ALIASES = STATIONS.flatMap(([canon, ...aliases]) => [canon, ...aliases].map((a) => ({ canon, a: a.toLowerCase(), m: makeMatcher(a) })))
    .sort((x, y) => y.a.length - x.a.length);

  function extractStation(norm) {
    for (const s of STATION_ALIASES) if (s.m(norm)) return s.canon;
    return null;
  }

  // ---------- Language detection ----------
  const GUJLISH = new Set(['che', 'chhe', 'nathi', 'kem', 'mane', 'tame', 'tamne', 'amne', 'hatu', 'hato', 'hati', 'thay', 'thai', 'thase', 'thayu',
    'bahu', 'ane', 'ma', 'mate', 'maate', 'kevi', 'kevu', 'kyare', 'aave', 'aavu', 'jaay', 'divas', 'saru', 'j', 'maari', 'mari', 'amari', 'pase',
    'bhaav', 'maange', 'kare', 'bharela', 'vaas', 'thi', 'kari', 'nai', 'padi', 'gayu', 'gai', 'chhu', 'chu', 'chho', 'shu', 'kai', 'aaje']);
  const HINGLISH = new Set(['hai', 'hain', 'nahi', 'nahin', 'kya', 'mujhe', 'mera', 'meri', 'bahut', 'kyon', 'kyun', 'raha', 'rahi', 'rahe', 'gaya',
    'gayi', 'mein', 'se', 'ko', 'ka', 'ke', 'abhi', 'jaldi', 'hafte', 'log', 'kaise', 'aur', 'pe', 'tha', 'diya', 'jayein', 'hum', 'humein', 'aap',
    'kab', 'kuch', 'koi', 'karo', 'kar']);
  const ENGLISH = new Set(['the', 'is', 'at', 'and', 'was', 'for', 'to', 'of', 'my', 'i', 'please', 'not', 'in', 'on', 'it', 'this', 'with', 'from',
    'a', 'an', 'are', 'be', 'has', 'have', 'there', 'no', 'very', 'me', 'we', 'by', 'but', 'near', 'did', 'nobody', 'today', 'someone', 'could']);

  function detectLanguage(text) {
    const s = String(text || '');
    const gu = (s.match(/[઀-૿]/g) || []).length;
    const hi = (s.match(/[ऀ-ॿ]/g) || []).length;
    if (gu > 0 && gu >= hi) return 'gu';
    if (hi > 0) return 'hi';
    const words = s.toLowerCase().match(/[a-z]+/g) || [];
    let g = 0, h = 0, e = 0;
    for (const w of words) { if (GUJLISH.has(w)) g++; if (HINGLISH.has(w)) h++; if (ENGLISH.has(w)) e++; }
    const best = Math.max(g, h);
    if (best >= 2 && best >= e * 0.6) return g >= h ? 'gu-Latn' : 'hi-Latn';
    return 'en';
  }

  // ---------- Classification ----------
  function tokens(norm) {
    return norm.split(/[\s.,!?;:()"'\-–—/|]+/).filter((t) => t.length >= 3);
  }

  /**
   * @param {string} text
   * @param {{channel?: string, learned?: Record<string, Record<string, number>>}} opts
   */
  function classify(text, opts = {}) {
    const norm = normalize(text);
    const scores = {};
    const hits = {};
    for (const d of DEPT_ORDER) {
      scores[d] = 0; hits[d] = [];
      for (const term of LEXICON[d]) if (term.m(norm)) { scores[d] += term.w; hits[d].push(term.t); }
    }
    // On-device learning: terms that controllers re-routed in the past nudge the score.
    if (opts.learned) {
      for (const tok of new Set(tokens(norm))) {
        const row = opts.learned[tok];
        if (!row) continue;
        for (const d in row) if (scores[d] !== undefined) scores[d] += Math.min(1.5, 0.5 * row[d]);
      }
    }
    const ranked = DEPT_ORDER.slice().sort((a, b) => scores[b] - scores[a] || DEPT_ORDER.indexOf(a) - DEPT_ORDER.indexOf(b));
    let dept = ranked[0];
    const total = DEPT_ORDER.reduce((sum, d) => sum + scores[d], 0);
    if (total === 0) dept = 'general';
    const secondary = scores[ranked[1]] > 0 && ranked[1] !== 'general' && dept !== ranked[1] ? ranked[1] : null;
    const confidence = total === 0 ? 0.2 : Math.round((scores[dept] / total) * 100) / 100;

    const urgency = scoreUrgency(norm, dept, opts.channel);
    return {
      lang: detectLanguage(text),
      dept, secondary, confidence,
      deptScores: scores, matched: hits[dept],
      station: extractStation(norm),
      ...urgency,
    };
  }

  function scoreUrgency(norm, dept, channel) {
    const signals = [{ label: `Base for ${DEPARTMENTS[dept].label}`, pts: DEPARTMENTS[dept].base }];
    for (const s of SIGNALS) {
      if (s.onlyFor && s.onlyFor !== dept) continue;
      if (s.m.some((m) => m(norm))) signals.push({ id: s.id, label: s.label, pts: s.pts });
    }
    if ((norm.match(/!/g) || []).length >= 2 && !signals.some((s) => s.id === 'immediacy')) {
      signals.push({ id: 'immediacy', label: 'Ongoing — needs immediate action', pts: 10 });
    }
    if (CHANNEL_BONUS[channel]) signals.push({ id: 'channel', ...CHANNEL_BONUS[channel] });
    const score = Math.min(100, signals.reduce((sum, s) => sum + s.pts, 0));
    return { urgency: score, level: levelFor(score), signals };
  }

  function levelFor(score) {
    if (score >= 75) return 'critical';
    if (score >= 55) return 'high';
    if (score >= 35) return 'medium';
    return 'low';
  }
  const SLA = { critical: '15 min', high: '4 h', medium: '24 h', low: '72 h' };

  // ---------- Draft replies ----------
  const REPLY = {
    en: {
      issue: { safety: 'a safety concern', lifts: 'the lift / escalator', fare: 'your fare / ticket', staff: 'staff behaviour', cleanliness: 'cleanliness', general: 'our service' },
      open: (id, issue, st) => `Namaste. We have received your complaint (Ref. ${id}) about ${issue}${st ? ` at ${st} station` : ''}.`,
      action: {
        critical: 'Our response team has been dispatched immediately and the station controller has been alerted.',
        high: 'This has been marked high priority and will be resolved within 4 hours.',
        medium: 'This will be resolved within 24 hours.',
        low: 'Our team will look into this within 72 hours.',
      },
      fare: 'If a refund is due, it will be credited to your original payment method within 5–7 working days.',
      staff: 'The matter has been escalated to the station manager for review.',
      close: 'We regret the inconvenience. — Metro Customer Care',
    },
    gu: {
      issue: { safety: 'સુરક્ષા', lifts: 'લિફ્ટ / એસ્કેલેટર', fare: 'ભાડું / ટિકિટ', staff: 'સ્ટાફના વર્તન', cleanliness: 'સફાઈ', general: 'સેવા' },
      open: (id, issue, st) => `નમસ્તે. ${st ? `${st} સ્ટેશન ખાતે ` : ''}${issue} અંગે આપની ફરિયાદ (ક્રમાંક ${id}) અમને મળી છે.`,
      action: {
        critical: 'અમારી ટીમને તાત્કાલિક મોકલવામાં આવી છે અને સ્ટેશન કંટ્રોલરને જાણ કરવામાં આવી છે.',
        high: 'આ મુદ્દાને પ્રાથમિકતા આપી 4 કલાકમાં ઉકેલવામાં આવશે.',
        medium: 'આ મુદ્દો 24 કલાકમાં ઉકેલવામાં આવશે.',
        low: 'અમારી ટીમ 72 કલાકમાં આ અંગે તપાસ કરશે.',
      },
      fare: 'રિફંડ બાકી હશે તો 5–7 કાર્યદિવસમાં આપના મૂળ પેમેન્ટ માધ્યમમાં જમા થશે.',
      staff: 'આ બાબત સ્ટેશન મેનેજરને સમીક્ષા માટે મોકલવામાં આવી છે.',
      close: 'અસુવિધા બદલ દિલગીર છીએ. — મેટ્રો ગ્રાહક સેવા',
    },
    hi: {
      issue: { safety: 'सुरक्षा', lifts: 'लिफ्ट / एस्केलेटर', fare: 'किराया / टिकट', staff: 'स्टाफ़ के व्यवहार', cleanliness: 'सफ़ाई', general: 'सेवा' },
      open: (id, issue, st) => `नमस्ते। ${st ? `${st} स्टेशन पर ` : ''}${issue} से जुड़ी आपकी शिकायत (क्रमांक ${id}) हमें मिल गई है।`,
      action: {
        critical: 'हमारी टीम को तुरंत भेजा गया है और स्टेशन कंट्रोलर को सूचित कर दिया गया है।',
        high: 'इस मामले को प्राथमिकता देकर 4 घंटे में हल किया जाएगा।',
        medium: 'इस मामले को 24 घंटे में हल किया जाएगा।',
        low: 'हमारी टीम 72 घंटे में इसकी जाँच करेगी।',
      },
      fare: 'रिफंड बनने पर राशि 5–7 कार्यदिवस में आपके मूल भुगतान माध्यम में जमा होगी।',
      staff: 'यह मामला समीक्षा के लिए स्टेशन मैनेजर को भेज दिया गया है।',
      close: 'असुविधा के लिए खेद है। — मेट्रो ग्राहक सेवा',
    },
    'gu-Latn': {
      issue: { safety: 'safety', lifts: 'lift / escalator', fare: 'bhadu / ticket', staff: 'staff na vartan', cleanliness: 'safai', general: 'seva' },
      open: (id, issue, st) => `Namaste. ${st ? `${st} station par ` : ''}${issue} vishe tamari complaint (No. ${id}) amne mali gai che.`,
      action: {
        critical: 'Amari team ne turant mokli che ane station controller ne jaan kari didhi che.',
        high: 'Aa issue ne priority aapi 4 kalak ma solve karvama aavshe.',
        medium: 'Aa issue 24 kalak ma solve karvama aavshe.',
        low: 'Amari team 72 kalak ma aa vishe tapas karshe.',
      },
      fare: 'Refund baki hoy to 5–7 working days ma tamara original payment ma jama thai jashe.',
      staff: 'Aa babat station manager ne review mate mokli che.',
      close: 'Asuvidha badal dilgir chiye. — Metro Customer Care',
    },
    'hi-Latn': {
      issue: { safety: 'safety', lifts: 'lift / escalator', fare: 'kiraya / ticket', staff: 'staff ke vyavhaar', cleanliness: 'safai', general: 'seva' },
      open: (id, issue, st) => `Namaste. ${st ? `${st} station par ` : ''}${issue} se judi aapki complaint (No. ${id}) humein mil gayi hai.`,
      action: {
        critical: 'Humari team turant bhej di gayi hai aur station controller ko inform kar diya gaya hai.',
        high: 'Is issue ko priority dekar 4 ghante mein solve kiya jayega.',
        medium: 'Is issue ko 24 ghante mein solve kiya jayega.',
        low: 'Humari team 72 ghante mein iski jaanch karegi.',
      },
      fare: 'Refund banta hai to 5–7 working days mein aapke original payment mein aa jayega.',
      staff: 'Yeh mamla review ke liye station manager ko bhej diya gaya hai.',
      close: 'Asuvidha ke liye khed hai. — Metro Customer Care',
    },
  };

  function draftReply(c, lang) {
    const L = REPLY[lang || c.lang] || REPLY.en;
    const parts = [L.open(c.id, L.issue[c.dept] || L.issue.general, c.station), L.action[c.level]];
    if (c.dept === 'fare') parts.push(L.fare);
    if (c.dept === 'staff') parts.push(L.staff);
    parts.push(L.close);
    return parts.join(' ');
  }

  // ---------- Learning from controller corrections ----------
  function learnCorrection(learned, text, toDept) {
    const out = { ...learned };
    for (const tok of new Set(tokens(normalize(text)))) {
      if (ENGLISH.has(tok) || GUJLISH.has(tok) || HINGLISH.has(tok) || /^\d+$/.test(tok)) continue;
      out[tok] = { ...(out[tok] || {}) };
      out[tok][toDept] = (out[tok][toDept] || 0) + 1;
    }
    return out;
  }

  const api = { DEPARTMENTS, DEPT_ORDER, LANGS, SLA, STATIONS, detectLanguage, classify, levelFor, draftReply, learnCorrection };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Triage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
