/*
 * Synthetic but realistic complaint batch (no real data is provided at the hackathon).
 * Mix of channels (app, social, email, paper) and languages (English, Gujarati, Hindi, Gujlish, Hinglish).
 * Station names are real Ahmedabad–Gandhinagar Metro stations; complaint content is invented.
 */
(function (root) {
  const SAMPLES = [
    ['app', 'Escalator at Kalupur Railway Station exit 2 stopped suddenly, an elderly lady fell down. Please send help immediately!'],
    ['social', 'Thaltej station par lift 3 divas thi bandh che, wheelchair walo kevi rite jaay? @metro'],
    ['email', 'વસ્ત્રાલ સ્ટેશન પર ટોઇલેટ ખૂબ ગંદા છે, પાણી પણ નથી. કૃપા કરીને સફાઈ કરાવો.'],
    ['paper', 'कालूपुर स्टेशन पर टिकट मशीन ने पैसे काट लिए लेकिन टिकट नहीं निकला। मुझे रिफंड चाहिए।'],
    ['app', 'Security guard at Old High Court was very rude and shouted at my father for no reason.'],
    ['social', 'Platform pe dhuaan aa raha hai Gurukul Road station pe, koi dekh raha hai kya?? jaldi karo'],
    ['app', 'મેટ્રોમાં એક માણસ મહિલાઓને હેરાન કરે છે, ટ્રેન હમણાં સ્ટેડિયમ સ્ટેશન પાસે છે. તાત્કાલિક મદદ કરો!'],
    ['email', 'I was charged twice on my metro card for the same trip from Thaltej to Vastral on Monday. Please refund.'],
    ['paper', 'Commerce Six Road station ma dustbin bharela che ane bahu vaas aave che.'],
    ['app', 'लिफ्ट में फंस गए हैं, जीवराज पार्क स्टेशन, दरवाज़ा नहीं खुल रहा, बच्चा साथ में है!'],
    ['social', 'Ticket counter staff at Sabarmati refused to give change and asked me to go away. Unprofessional.'],
    ['app', 'Water leaking from roof near platform 1 at Gandhigram, floor is slippery, someone could slip.'],
    ['email', 'QR ટિકિટ સ્કેન નથી થતી, ગેટ ખુલતો નથી. દરરોજ મોડું થાય છે. થલતેજ ગામ સ્ટેશન.'],
    ['app', 'Station bahar autowala bahu bhaav maange che ane gate pase bheed kare che, Apparel Park.'],
    ['social', 'Ranip station ka escalator 1 hafte se band hai, buzurg log kaise jayein?'],
    ['paper', 'Coach floor was dirty with spilled food and nobody cleaned it between Motera and Sabarmati.'],
    ['app', 'महिला कोच में पुरुष यात्री बैठे थे, स्टाफ ने कुछ नहीं कहा। शाहपुर से कालूपुर के बीच।'],
    ['email', 'Fare from APMC to Motera Stadium seems higher than the published fare chart. Please clarify.'],
    ['app', 'એસ્કેલેટર ખૂબ ઝડપથી ચાલે છે અને આંચકા મારે છે, શાહપુર સ્ટેશન. કોઈ પડી શકે છે.'],
    ['social', 'Staff walo mobile ma j busy hato, maari madad j na kari. Vijaynagar station. Bahu kharab experience.'],
    ['app', 'There is an unattended bag lying near gate B at Gujarat University station for 30 minutes.'],
    ['paper', 'स्टेशन पर पीने का पानी नहीं है और शौचालय बंद है। पालडी स्टेशन।'],
    ['email', 'Card recharge done online but balance not updated at the station gate. Transaction ID TXN88213.'],
    ['app', 'AC kaam nahi kar raha coach mein, bahut garmi hai, ek uncle ko chakkar aa gaya. Next station Paldi.'],
    ['social', 'Great service today but the lift at Doordarshan Kendra makes a grinding noise, please check.'],
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = SAMPLES;
  else root.SAMPLE_COMPLAINTS = SAMPLES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
