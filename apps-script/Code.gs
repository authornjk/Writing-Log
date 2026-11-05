/**
 * Writing Log — nightly word count.
 * Right after midnight, records each book's word count into "Writing Log data.json" in your
 * Google Drive as the day that just ended, so days you don't open the app still get counted.
 * Setup: paste this into a new project at script.google.com, run setup() once, and allow access.
 */
const FILE_NAME = 'Writing Log data.json';
const TIME_ZONE = 'America/Denver';

function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('recordNightly').timeBased().everyDays(1).atHour(0).nearMinute(5).inTimezone(TIME_ZONE).create();
}

function recordNightly() {
  const files = DriveApp.getFilesByName(FILE_NAME);
  if (!files.hasNext()) return;
  const file = files.next();
  const data = JSON.parse(file.getBlob().getDataAsString());
  // Runs just after midnight, so the count belongs to the day that just ended.
  const date = Utilities.formatDate(new Date(Date.now() - 2 * 60 * 60 * 1000), TIME_ZONE, 'yyyy-MM-dd');
  data.snapshots = data.snapshots || {};
  let changed = false;
  (data.books || []).forEach(function (b) {
    try {
      const n = countDoc(b.docId);
      const m = data.snapshots[b.docId] = data.snapshots[b.docId] || {};
      if (!m[date] || m[date].count !== n || (m[date].m || 'api') !== 'api') { m[date] = { count: n, at: Date.now(), m: 'api' }; changed = true; }
    } catch (e) { console.error('Could not count ' + b.title + ': ' + e); }
  });
  if (changed) file.setContent(JSON.stringify(data));
}

function countDoc(id) {
  const body = DocumentApp.openById(id).getBody();
  const H = DocumentApp.ParagraphHeading;
  const lines = [];
  for (let i = 0; i < body.getNumChildren(); i++) {
    const el = body.getChild(i), type = el.getType();
    if (type === DocumentApp.ElementType.PARAGRAPH) {
      const p = el.asParagraph(), h = p.getHeading();
      lines.push((h === H.HEADING1 || h === H.HEADING2 || h === H.HEADING3 || h === H.TITLE ? '# ' : '') + p.getText());
    } else if (type === DocumentApp.ElementType.LIST_ITEM) lines.push(el.asListItem().getText());
    else if (type === DocumentApp.ElementType.TABLE) lines.push(el.asTable().getText());
  }
  return countWords(lines.join('\n'));
}

// Same rule as the app: everything from an "Acknowledgements" or "Dark Matter" heading onward is left out.
function countWords(text) {
  const cut = text.search(/^#{1,3}[ \t]*(acknowledg|dark matter)/im);
  if (cut >= 0) text = text.slice(0, cut);
  text = text.replace(/\\(.)/g, '$1').replace(/[#*_]+/g, ' ').replace(/[—–]/g, ' ');
  return text.split(/\s+/).filter(function (t) { return /[\p{L}\p{N}]/u.test(t); }).length;
}
