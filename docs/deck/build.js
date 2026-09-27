const pptxgen = require('pptxgenjs');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const sharp = require('sharp');
const fa = require('react-icons/fa');

// Palette: deep teal (dominant), sage (support), warm apricot (accent)
const C = {
  teal: '1F4E5A', tealDark: '153840', sage: '84B59F', sageLight: 'E8F1EC',
  apricot: 'F2A65A', ink: '1E2A2E', muted: '5E6E72', white: 'FFFFFF', line: 'D5E2DC',
  red: 'C8553D',
};
const HEAD = 'Cambria';
const BODY = 'Calibri';

async function icon(name, color, size = 96) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(fa[name], { color: '#' + color, size }),
  );
  const buf = await sharp(Buffer.from(svg)).png({ palette: true, compressionLevel: 9 }).toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}

// Motif: icon inside a filled circle.
async function circleIcon(slide, name, x, y, d, fill, fg) {
  slide.addShape('ellipse', { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill } });
  const pad = d * 0.26;
  slide.addImage({ data: await icon(name, fg), x: x + pad, y: y + pad, w: d - 2 * pad, h: d - 2 * pad });
}

function title(slide, text, opts = {}) {
  slide.addText(text, {
    x: 0.5, y: 0.35, w: 9, h: 0.7, fontFace: HEAD, fontSize: 30, bold: true,
    color: opts.color || C.teal, margin: 0, isTextBox: true,
  });
}

function subtitle(slide, text, opts = {}) {
  slide.addText(text, {
    x: 0.5, y: 1.0, w: 9, h: 0.4, fontFace: BODY, fontSize: 14, italic: true,
    color: opts.color || C.muted, margin: 0, isTextBox: true,
  });
}

// Numbered tutorial steps (numbers in apricot circles).
function steps(slide, items, x, y, w, rowH = 0.72) {
  items.forEach((s, i) => {
    const yy = y + i * rowH;
    slide.addShape('ellipse', { x, y: yy, w: 0.42, h: 0.42, fill: { color: C.apricot }, line: { color: C.apricot } });
    slide.addText(String(i + 1), {
      x, y: yy, w: 0.42, h: 0.42, align: 'center', valign: 'middle', fontFace: BODY, fontSize: 14,
      bold: true, color: C.white, margin: 0, isTextBox: true,
    });
    slide.addText([
      { text: s[0], options: { bold: true, color: C.ink, breakLine: true } },
      { text: s[1], options: { color: C.muted } },
    ], {
      x: x + 0.58, y: yy - 0.05, w: w - 0.58, h: rowH - 0.05, fontFace: BODY, fontSize: 12.5,
      valign: 'top', margin: 0, isTextBox: true,
    });
  });
}

function tip(slide, text, x, y, w, h) {
  slide.addShape('roundRect', {
    x, y, w, h, rectRadius: 0.08, fill: { color: C.sageLight }, line: { color: C.sageLight },
  });
  slide.addText([
    { text: 'Tip  ', options: { bold: true, color: C.teal } },
    { text, options: { color: C.ink } },
  ], { x: x + 0.15, y, w: w - 0.3, h, fontFace: BODY, fontSize: 11.5, valign: 'middle', margin: 0, isTextBox: true });
}

function whereChip(slide, text, x = 0.5, y = 1.0) {
  slide.addShape('roundRect', { x, y, w: 4.1, h: 0.34, rectRadius: 0.17, fill: { color: C.sageLight }, line: { color: C.sageLight } });
  slide.addText(text, { x: x + 0.15, y, w: 3.8, h: 0.34, fontFace: BODY, fontSize: 11, color: C.teal, valign: 'middle', margin: 0, isTextBox: true });
}

// Simple phone mock with chat bubbles.
function phone(slide, x, y, header, bubbles, h = 4.2) {
  const w = 2.55;
  slide.addShape('roundRect', {
    x, y, w, h, rectRadius: 0.25, fill: { color: C.white }, line: { color: C.teal, width: 2 },
    shadow: { type: 'outer', color: '000000', blur: 6, offset: 2, angle: 90, opacity: 0.18 },
  });
  slide.addShape('roundRect', { x: x + 0.12, y: y + 0.12, w: w - 0.24, h: 0.42, rectRadius: 0.12, fill: { color: C.teal }, line: { color: C.teal } });
  slide.addText(header, { x: x + 0.22, y: y + 0.12, w: w - 0.44, h: 0.42, fontFace: BODY, fontSize: 10.5, bold: true, color: C.white, valign: 'middle', margin: 0, isTextBox: true });
  let yy = y + 0.7;
  bubbles.forEach((b) => {
    const bw = b.w || 1.9;
    const bx = b.me ? x + w - 0.15 - bw : x + 0.15;
    const fill = b.fill || (b.me ? C.teal : C.sageLight);
    const color = b.color || (b.me ? C.white : C.ink);
    slide.addShape('roundRect', { x: bx, y: yy, w: bw, h: b.h || 0.5, rectRadius: 0.1, fill: { color: fill }, line: { color: b.border || fill } });
    slide.addText(b.text, { x: bx + 0.08, y: yy, w: bw - 0.16, h: b.h || 0.5, fontFace: BODY, fontSize: 9, color, valign: 'middle', margin: 0, bold: !!b.bold, isTextBox: true });
    yy += (b.h || 0.5) + 0.12;
  });
}

(async () => {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_16x9';
  pres.title = 'AuraConnect — Overview & Quick Tutorials';

  // 1. Title
  {
    const s = pres.addSlide();
    s.background = { color: C.teal };
    await circleIcon(s, 'FaComments', 0.6, 0.7, 1.0, C.apricot, C.white);
    s.addText('AuraConnect', { x: 0.6, y: 1.9, w: 8.8, h: 0.9, fontFace: HEAD, fontSize: 48, bold: true, color: C.white, margin: 0, isTextBox: true });
    s.addText('Secure messaging and care coordination for hospice teams', { x: 0.6, y: 2.8, w: 8.8, h: 0.5, fontFace: BODY, fontSize: 20, color: C.sageLight, margin: 0, isTextBox: true });
    s.addText('Overview & quick tutorials', { x: 0.6, y: 4.5, w: 6, h: 0.4, fontFace: BODY, fontSize: 14, italic: true, color: C.sage, margin: 0, isTextBox: true });
    s.addNotes('Welcome. AuraConnect replaces texting, paging and phone tag with one secure app for the whole hospice team — iPhone for the field, web console for the office.');
  }

  // 2. What it does — three pillars
  {
    const s = pres.addSlide();
    title(s, 'One place for the whole care team');
    subtitle(s, 'Built for hospice: the right person, the right message, with nothing lost after hours');
    const cols = [
      ['FaComments', 'Communicate', 'Secure 1:1, group, team and patient channels. Urgent messages escalate until someone acknowledges.'],
      ['FaCalendarDay', 'Coordinate', 'Today view, visits, tasks, on-call routing, after-hours triage and IDG meetings in one app.'],
      ['FaShieldAlt', 'Stay compliant', 'NOE, recert, F2F and HOPE deadlines tracked automatically, with a full audit trail.'],
    ];
    for (let i = 0; i < 3; i++) {
      const x = 0.5 + i * 3.05;
      s.addShape('roundRect', { x, y: 1.7, w: 2.85, h: 3.3, rectRadius: 0.12, fill: { color: C.white }, line: { color: C.line },
        shadow: { type: 'outer', color: '000000', blur: 5, offset: 1, angle: 90, opacity: 0.12 } });
      await circleIcon(s, cols[i][0], x + 0.25, 1.95, 0.8, C.teal, C.white);
      s.addText(cols[i][1], { x: x + 0.25, y: 2.9, w: 2.4, h: 0.45, fontFace: HEAD, fontSize: 20, bold: true, color: C.teal, margin: 0, isTextBox: true });
      s.addText(cols[i][2], { x: x + 0.25, y: 3.4, w: 2.4, h: 1.4, fontFace: BODY, fontSize: 13, color: C.ink, valign: 'top', margin: 0, isTextBox: true });
    }
    s.addNotes('Three jobs: communicate securely, coordinate the day, and keep the agency compliant without extra paperwork.');
  }

  // 3. Who uses it
  {
    const s = pres.addSlide();
    title(s, 'Designed around every role');
    const roles = [
      ['FaUserNurse', 'RN case managers', 'Today view, visits, patient channels, handoff'],
      ['FaHandsHelping', 'Aides & LPNs', 'Visit list, message my RN, photo updates'],
      ['FaUserMd', 'Medical director & NPs', 'Escalations, recerts, IDG review'],
      ['FaHandHoldingHeart', 'Social work & chaplains', 'Visits, IDG notes, bereavement'],
      ['FaFileMedical', 'Intake', 'Referral scan, AI extraction, admission'],
      ['FaUserShield', 'Administrators & DON', 'Staff, schedules, reports, audit log'],
    ];
    for (let i = 0; i < roles.length; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 0.5 + col * 4.6, y = 1.3 + row * 1.35;
      await circleIcon(s, roles[i][0], x, y, 0.75, i % 2 ? C.sage : C.teal, C.white);
      s.addText(roles[i][1], { x: x + 0.95, y: y + 0.02, w: 3.5, h: 0.35, fontFace: BODY, fontSize: 15, bold: true, color: C.ink, margin: 0, isTextBox: true });
      s.addText(roles[i][2], { x: x + 0.95, y: y + 0.38, w: 3.5, h: 0.35, fontFace: BODY, fontSize: 12.5, color: C.muted, margin: 0, isTextBox: true });
    }
    s.addNotes('Permissions follow role and discipline: only RN, NP, MD or admins can record a death or recertify; volunteers see only their assigned patients.');
  }

  // 4. Platform & security
  {
    const s = pres.addSlide();
    title(s, 'How it fits together');
    const tiles = [
      ['FaMobileAlt', 'iPhone app', 'Field staff: messaging, Today, visits, triage, scanning. Face ID lock.'],
      ['FaDesktop', 'Web console', 'Office staff and admins: intake, scheduling, reports, settings.'],
      ['FaCloud', 'Secure cloud', 'Google Cloud under a HIPAA BAA. Encrypted, with a full audit trail.'],
    ];
    for (let i = 0; i < 3; i++) {
      const y = 1.25 + i * 1.05;
      await circleIcon(s, tiles[i][0], 0.5, y, 0.7, C.teal, C.white);
      s.addText(tiles[i][1], { x: 1.4, y, w: 3.6, h: 0.35, fontFace: BODY, fontSize: 15, bold: true, color: C.ink, margin: 0, isTextBox: true });
      s.addText(tiles[i][2], { x: 1.4, y: y + 0.35, w: 3.6, h: 0.5, fontFace: BODY, fontSize: 12, color: C.muted, margin: 0, isTextBox: true });
    }
    s.addShape('roundRect', { x: 5.4, y: 1.25, w: 4.1, h: 3.7, rectRadius: 0.12, fill: { color: C.teal }, line: { color: C.teal } });
    await circleIcon(s, 'FaLock', 5.65, 1.45, 0.6, C.apricot, C.white);
    s.addText('Privacy by design', { x: 6.4, y: 1.5, w: 3, h: 0.5, fontFace: HEAD, fontSize: 18, bold: true, color: C.white, margin: 0, isTextBox: true });
    s.addText([
      { text: 'Notifications never show patient details', options: { bullet: true, breakLine: true } },
      { text: 'Face ID lock and blur in the app switcher', options: { bullet: true, breakLine: true } },
      { text: 'Copied text stays on the device', options: { bullet: true, breakLine: true } },
      { text: 'Access removed instantly when staff leave', options: { bullet: true, breakLine: true } },
      { text: 'Every clinical action is audited', options: { bullet: true } },
    ], { x: 5.65, y: 2.25, w: 3.7, h: 2.5, fontFace: BODY, fontSize: 13, color: C.white, paraSpaceAfter: 6, valign: 'top', margin: 0, isTextBox: true });
    s.addNotes('Stress: a lock-screen notification says "New message" or "Urgent alert" — never a patient name. Staff open the app to see details.');
  }

  // 5. Section divider
  {
    const s = pres.addSlide();
    s.background = { color: C.teal };
    await circleIcon(s, 'FaListAlt', 0.6, 1.6, 0.9, C.apricot, C.white);
    s.addText('Quick tutorials', { x: 0.6, y: 2.65, w: 8.8, h: 0.8, fontFace: HEAD, fontSize: 40, bold: true, color: C.white, margin: 0, isTextBox: true });
    s.addText('Each takes about a minute. Steps refer to the iPhone app unless marked Web.', { x: 0.6, y: 3.45, w: 8.8, h: 0.5, fontFace: BODY, fontSize: 16, color: C.sageLight, margin: 0, isTextBox: true });
  }

  // 6. Send a message with a template
  {
    const s = pres.addSlide();
    title(s, 'Send a message with a template');
    whereChip(s, 'Inbox → pick a conversation, or tap New');
    steps(s, [
      ['Open the conversation', 'Patient channels already include the whole care team.'],
      ['Type "/" or tap the template button', 'Pick SBAR, fall report, symptom crisis, running late…'],
      ['Fill in the short form', 'Patient name, code status and your name fill in for you.'],
      ['Set priority and send', 'Normal, Urgent or Critical. Urgent messages escalate until acknowledged.'],
    ], 0.5, 1.6, 5.2);
    phone(s, 6.7, 1.3, 'Test, Alice – Care Team', [
      { text: 'SBAR — S: New onset dyspnea at rest. B: Lung CA, on O2 2L…', w: 2.1, h: 0.7, me: true },
      { text: 'URGENT', w: 0.8, h: 0.28, me: true, fill: C.apricot, bold: true },
      { text: 'Dr. Patel: Seen — calling you now.', w: 1.9 },
      { text: 'On my way', w: 1.0, h: 0.36, me: true },
    ], 3.9);
    s.addNotes('Admins manage the org template library under Web → Templates (Seed defaults loads 11 hospice templates). Anyone can save personal templates.');
  }

  // 7. Urgent alerts, acknowledge, quick replies
  {
    const s = pres.addSlide();
    title(s, 'Answer urgent alerts in seconds');
    whereChip(s, 'Lock screen notification · Alerts tab', 3.7, 1.0);
    phone(s, 0.6, 1.2, 'Lock screen', [
      { text: 'AuraConnect\nUrgent alert — tap to acknowledge', w: 2.25, h: 0.7, fill: C.white, border: C.line },
      { text: 'Acknowledge', w: 2.25, h: 0.38, fill: C.teal, color: C.white, bold: true },
      { text: 'Reply…', w: 2.25, h: 0.38, fill: C.sageLight },
    ], 3.9);
    steps(s, [
      ['Long-press the notification', 'Choose Acknowledge or Reply after unlocking. No patient details are shown.'],
      ['Or reply in the chat', 'Replying in the channel automatically acknowledges your alert.'],
      ['Use one-tap quick replies', '"On my way", "Call me", "Will visit within 1 hr".'],
      ['Unanswered alerts escalate', 'The escalation policy pages the next person until someone acknowledges.'],
    ], 3.7, 1.55, 5.8);
    s.addNotes('Critical alerts sound through silent mode once Apple approves the Critical Alerts entitlement.');
  }

  // 8. @mentions and message the on-call role
  {
    const s = pres.addSlide();
    title(s, 'Reach the right person — even at 2am');
    subtitle(s, 'Message a role instead of guessing who is working');
    const cards = [
      ['FaAt', '@mention someone', 'Type @ and pick a name, e.g. @Dr. Patel. Only mentioned people are pinged in busy channels.'],
      ['FaPhoneAlt', 'Message the on-call role', 'New message → On-call role → "On-call RN North". It goes to whoever is on shift right now.'],
      ['FaUsers', 'Use the directory', 'More → Directory shows who is available, in a visit, off, or out of office.'],
    ];
    for (let i = 0; i < 3; i++) {
      const y = 1.6 + i * 1.12;
      s.addShape('roundRect', { x: 0.5, y, w: 9, h: 0.95, rectRadius: 0.1, fill: { color: i % 2 ? C.white : C.sageLight }, line: { color: C.line } });
      await circleIcon(s, cards[i][0], 0.7, y + 0.13, 0.68, C.teal, C.white);
      s.addText(cards[i][1], { x: 1.6, y: y + 0.08, w: 7.6, h: 0.35, fontFace: BODY, fontSize: 15, bold: true, color: C.ink, margin: 0, isTextBox: true });
      s.addText(cards[i][2], { x: 1.6, y: y + 0.43, w: 7.7, h: 0.45, fontFace: BODY, fontSize: 12.5, color: C.muted, margin: 0, isTextBox: true });
    }
    s.addNotes('@oncall-rn-north also works inside any channel: the mention resolves to the current shift holder, skipping anyone off duty.');
  }

  // 9. Notification settings & status
  {
    const s = pres.addSlide();
    title(s, 'Control your notifications');
    whereChip(s, 'More → My status · Notifications · channel ⓘ');
    steps(s, [
      ['Set your status', 'Available, In visit, Busy or Off. Colleagues see it in the directory.'],
      ['Turn on quiet hours or off-shift quiet', 'Normal messages wait; urgent and critical always come through.'],
      ['Tune each channel', 'Tap the channel name → All, Mentions only, Urgent only, or Mute for a while.'],
      ['Going away? Set out of office', 'Add a return date and a delegate; people who message you are pointed to them.'],
    ], 0.5, 1.6, 5.4);
    s.addShape('roundRect', { x: 6.3, y: 1.6, w: 3.2, h: 3.2, rectRadius: 0.15, fill: { color: C.teal }, line: { color: C.teal } });
    await circleIcon(s, 'FaMoon', 7.45, 1.85, 0.9, C.apricot, C.white);
    s.addText('35%', { x: 6.3, y: 2.85, w: 3.2, h: 0.8, fontFace: HEAD, fontSize: 44, bold: true, color: C.white, align: 'center', margin: 0, isTextBox: true });
    s.addText('fewer message notifications in our load test with typical settings', { x: 6.55, y: 3.65, w: 2.7, h: 0.9, fontFace: BODY, fontSize: 12, color: C.sageLight, align: 'center', margin: 0, isTextBox: true });
    s.addNotes('The 35% figure comes from our simulated week at a census of 100 (2,000 messages): 19.2k → 12.5k pushes.');
  }

  // 10. Today tab
  {
    const s = pres.addSlide();
    title(s, 'Start your day on the Today tab');
    const sections = [
      ['FaBell', 'My alerts', 'Open alerts with the patient name. Swipe to acknowledge.'],
      ['FaCalendarDay', 'Visits today', 'Address, code status, allergies and caregiver at a tap. Swipe to complete.'],
      ['FaRegClock', 'Missed & overdue', 'Document a missed visit late or reschedule it.'],
      ['FaClipboardList', 'Tasks due', 'Admission, recert and post-death checklists, assigned automatically.'],
    ];
    for (let i = 0; i < 4; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 0.5 + col * 4.6, y = 1.35 + row * 1.85;
      s.addShape('roundRect', { x, y, w: 4.4, h: 1.65, rectRadius: 0.12, fill: { color: C.white }, line: { color: C.line },
        shadow: { type: 'outer', color: '000000', blur: 4, offset: 1, angle: 90, opacity: 0.1 } });
      await circleIcon(s, sections[i][0], x + 0.25, y + 0.25, 0.65, C.sage, C.white);
      s.addText(sections[i][1], { x: x + 1.1, y: y + 0.25, w: 3.1, h: 0.4, fontFace: BODY, fontSize: 16, bold: true, color: C.ink, margin: 0, isTextBox: true });
      s.addText(sections[i][2], { x: x + 1.1, y: y + 0.68, w: 3.1, h: 0.8, fontFace: BODY, fontSize: 12.5, color: C.muted, valign: 'top', margin: 0, isTextBox: true });
    }
    s.addNotes('Phone numbers and addresses are tappable: call the caregiver or open Maps straight from the visit card.');
  }

  // 11. After-hours triage
  {
    const s = pres.addSlide();
    title(s, 'Handle an after-hours call');
    whereChip(s, 'More → Triage calls → Log call');
    steps(s, [
      ['Log the call', 'Caller, patient, reason, symptoms and urgency. It routes to the on-call nurse.'],
      ['Urgent and emergent calls page on-call', 'They escalate until acknowledged. Routine calls still notify the assignee.'],
      ['Resolve with a disposition', 'Advice given, visit made, MD contacted, 911… Add a PRN visit in one step.'],
      ['Morning handoff', 'Shift handoff → "My overnight activity" summarizes calls, visits and deaths.'],
    ], 0.5, 1.6, 5.6);
    tip(s, 'On call and not on the care team? Tap "Join for on-call coverage" to read the patient\'s channel until your shift ends.', 6.4, 1.7, 3.1, 1.6);
    s.addNotes('Coverage access is audited and removed automatically at the end of the shift.');
  }

  // 12. Referral scan to admission
  {
    const s = pres.addSlide();
    title(s, 'From referral to admission');
    subtitle(s, 'Scan it once — AI drafts the chart, a person always confirms');
    const flow = [
      ['FaCamera', 'Scan or upload', 'iPhone camera, PDF, fax — or log a phone referral'],
      ['FaRobot', 'AI extraction', 'Demographics, diagnoses, meds and physicians'],
      ['FaSearch', 'Review', 'Low-confidence fields are highlighted, and duplicates flagged'],
      ['FaUserPlus', 'Admit', 'Consents, care team and visit plan; deadlines set automatically'],
    ];
    for (let i = 0; i < 4; i++) {
      const x = 0.5 + i * 2.3;
      await circleIcon(s, flow[i][0], x + 0.55, 1.75, 0.95, i === 1 ? C.apricot : C.teal, C.white);
      if (i < 3) s.addShape('line', { x: x + 1.6, y: 2.22, w: 1.15, h: 0, line: { color: C.sage, width: 2, endArrowType: 'triangle' } });
      s.addText(flow[i][1], { x, y: 2.9, w: 2.05, h: 0.4, fontFace: BODY, fontSize: 15, bold: true, color: C.ink, align: 'center', margin: 0, isTextBox: true });
      s.addText(flow[i][2], { x, y: 3.3, w: 2.05, h: 0.9, fontFace: BODY, fontSize: 12, color: C.muted, align: 'center', valign: 'top', margin: 0, isTextBox: true });
    }
    tip(s, 'Claim a referral before reviewing it. Others see "X is reviewing", so two coordinators never collide.', 0.5, 4.45, 9, 0.6);
    s.addNotes('Non-admits (declined, not eligible, died before admission) are closed with a reason for tracking. Transfers from another hospice keep their benefit period dates.');
  }

  // 13. Death visit & bereavement
  {
    const s = pres.addSlide();
    title(s, 'Death visit and bereavement');
    whereChip(s, 'Visit card → Record death (RN, NP, MD)');
    steps(s, [
      ['Record death from the visit', 'Time, pronounced by and location. The visit is completed, not cancelled.'],
      ['Team is notified', 'The care team gets an alert, and the channel stays open 72 hours for coordination.'],
      ['Post-death tasks appear', 'Notify MD, DME pickup, medication disposal, death summary.'],
      ['Bereavement plan starts', '13 months of calls and letters with a risk assessment. Mailing lists export to CSV.'],
    ], 0.5, 1.6, 5.6);
    await circleIcon(s, 'FaDove', 7.1, 1.7, 1.6, C.sageLight, C.teal);
    s.addText('Every step is recorded for the chart and survey.', { x: 6.4, y: 3.5, w: 3.0, h: 0.8, fontFace: HEAD, fontSize: 15, italic: true, color: C.teal, align: 'center', margin: 0, isTextBox: true });
    s.addNotes('Bereavement risk must be chosen when recording the death — there is no default, so high-risk families are not under-triaged.');
  }

  // 14. Deadlines & IDG
  {
    const s = pres.addSlide();
    title(s, 'Deadlines and IDG, handled');
    const left = [
      ['NOE', 'due 5 days after election'],
      ['Recert', '90 / 90 / 60-day benefit periods'],
      ['F2F', 'window before period 3+'],
      ['HOPE', 'admission, HUV1 and HUV2 windows'],
    ];
    s.addText('Tracked automatically', { x: 0.5, y: 1.15, w: 4.3, h: 0.4, fontFace: BODY, fontSize: 16, bold: true, color: C.teal, margin: 0, isTextBox: true });
    left.forEach((r, i) => {
      const y = 1.65 + i * 0.72;
      s.addShape('roundRect', { x: 0.5, y, w: 1.2, h: 0.55, rectRadius: 0.1, fill: { color: C.teal }, line: { color: C.teal } });
      s.addText(r[0], { x: 0.5, y, w: 1.2, h: 0.55, fontFace: BODY, fontSize: 14, bold: true, color: C.white, align: 'center', valign: 'middle', margin: 0, isTextBox: true });
      s.addText(r[1], { x: 1.85, y, w: 3.0, h: 0.55, fontFace: BODY, fontSize: 13, color: C.ink, valign: 'middle', margin: 0, isTextBox: true });
    });
    s.addText('Reminders go to RN, NP and MD before the due date and escalate if overdue. Mark filed with the actual filing date.', { x: 0.5, y: 4.55, w: 4.4, h: 0.7, fontFace: BODY, fontSize: 11.5, color: C.muted, margin: 0, isTextBox: true });
    s.addShape('roundRect', { x: 5.3, y: 1.15, w: 4.2, h: 4.05, rectRadius: 0.12, fill: { color: C.sageLight }, line: { color: C.sageLight } });
    await circleIcon(s, 'FaUsers', 5.55, 1.35, 0.65, C.teal, C.white);
    s.addText('IDG meetings', { x: 6.35, y: 1.45, w: 3, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: C.teal, margin: 0, isTextBox: true });
    s.addText([
      { text: 'Agenda fills with patients due for review', options: { bullet: true, breakLine: true } },
      { text: 'Generate AI prep for the whole agenda', options: { bullet: true, breakLine: true } },
      { text: 'Each discipline writes its own note', options: { bullet: true, breakLine: true } },
      { text: 'Action items become assigned tasks', options: { bullet: true, breakLine: true } },
      { text: 'Completing sets the next review date', options: { bullet: true } },
    ], { x: 5.55, y: 2.2, w: 3.8, h: 2.8, fontFace: BODY, fontSize: 13, color: C.ink, paraSpaceAfter: 6, valign: 'top', margin: 0, isTextBox: true });
    s.addNotes('Clinical and compliance staff should confirm the deadline rules match your agency\'s interpretation before go-live.');
  }

  // 15. Admin essentials
  {
    const s = pres.addSlide();
    title(s, 'Admin essentials (Web)');
    subtitle(s, 'Set up once; the app routes and reminds from there');
    const items = [
      ['FaUserPlus', 'Invite staff', 'Members → Invite. They get an email link and set a password.'],
      ['FaCalendarDay', 'On-call schedule', 'Roles and shifts; copy last week; coverage-gap warnings.'],
      ['FaBolt', 'Escalation policy', 'Who gets paged next, and after how many minutes.'],
      ['FaCogs', 'Capabilities', 'Give schedulers, coordinators and QA just the access they need.'],
      ['FaChartLine', 'Reports', 'Dashboard, compliance, census, volunteer 5% and CSV export.'],
      ['FaUserClock', 'Offboarding', 'One wizard reassigns patients, visits, tasks and shifts.'],
    ];
    for (let i = 0; i < items.length; i++) {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 0.5 + col * 3.05, y = 1.65 + row * 1.8;
      await circleIcon(s, items[i][0], x, y, 0.62, row ? C.sage : C.teal, C.white);
      s.addText(items[i][1], { x, y: y + 0.72, w: 2.85, h: 0.35, fontFace: BODY, fontSize: 14.5, bold: true, color: C.ink, margin: 0, isTextBox: true });
      s.addText(items[i][2], { x, y: y + 1.05, w: 2.85, h: 0.65, fontFace: BODY, fontSize: 12, color: C.muted, valign: 'top', margin: 0, isTextBox: true });
    }
    s.addNotes('Deactivating a member takes effect immediately across the app; the last admin cannot be removed.');
  }

  // 16. Getting started
  {
    const s = pres.addSlide();
    s.background = { color: C.teal };
    s.addText('Getting started', { x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontFace: HEAD, fontSize: 36, bold: true, color: C.white, margin: 0, isTextBox: true });
    const todo = [
      'Accept your invite email and set a password',
      'Install AuraConnect on your iPhone and turn on Face ID lock',
      'Allow notifications, then set your status and quiet hours',
      'Open Today and review your patients, visits and tasks',
      'Send your first message using a template',
    ];
    for (let i = 0; i < todo.length; i++) {
      const y = 1.55 + i * 0.68;
      await circleIcon(s, 'FaCheckCircle', 0.6, y, 0.45, C.apricot, C.white);
      s.addText(todo[i], { x: 1.25, y, w: 8, h: 0.45, fontFace: BODY, fontSize: 16, color: C.white, valign: 'middle', margin: 0, isTextBox: true });
    }
    s.addText('Questions? Ask your AuraConnect administrator.', { x: 0.6, y: 5.0, w: 8.8, h: 0.35, fontFace: BODY, fontSize: 13, italic: true, color: C.sage, margin: 0, isTextBox: true });
  }

  await pres.writeFile({ fileName: 'AuraConnect-Overview.pptx' });
  console.log('written');
})();
