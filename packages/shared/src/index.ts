export {
  normalizeVaultPath,
  normalizeVaultFilePath,
  isValidVaultPath,
  VaultPathError,
  HiddenVaultPathError,
} from './path.js';
export { extractSection } from './sections.js';
export { parseNote, type ParsedNote } from './markdown.js';
export {
  parsePropertiesModel,
  serializeProperties,
  serializeFrontmatterBlock,
  hasKeyedProperties,
  parsePropInput,
  isDateLike,
  type PropEntry,
  type PropScalar,
} from './frontmatter.js';
export {
  extractTags,
  extractLinks,
  extractTasks,
  frontmatterTags,
  noteTitle,
  rewriteLinks,
  type NoteTask,
  type RewriteResult,
  type WikiLink,
} from './extract.js';
export {
  parseQuery,
  executeQuery,
  runQuery,
  DqlParseError,
  type DqlQuery,
  type DqlCondition,
  type DqlComparisonOp,
  type DqlSource,
  type QueryableNote,
} from './dql.js';
export {
  resolveLinkTarget,
  preferredLinkTarget,
  resolveFileLinkTarget,
  preferredFileLinkTarget,
} from './links.js';
export {
  JOURNAL_DIR,
  isValidJournalDate,
  journalPath,
  journalDayOfWeek,
  shiftJournalDate,
  todayJournalDate,
  JournalDateError,
} from './journal.js';
export { toLf, appendText, countOccurrences } from './text.js';
export * from './schemas.js';
