/**
 * エディタへのファイル D&D / クリップボード貼り付けアップロード (Sf53ad6-2)。
 *
 * - drop:  ドロップ位置 (posAtCoords) へ、アップロード完了後に ![[パス]] を挿入
 * - paste: ファイル (画像等) を含む貼り付けを横取りし、カーソル位置へ挿入
 * - drag 中は App のドロップオーバーレイ (drop-overlay) を表示する
 *
 * アップロード実体 (保存先の決定・連番リネーム・トースト) は App が
 * uploadEnvFacet 経由で注入する。ファイルへは記法どおりの ![[...]] しか
 * 書かない (priority 1: ピュア Markdown)。
 */
import { Facet, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export interface UploadEnv {
  /**
   * ファイル群をアップロードし、保存された vault 相対パスを返す。
   * 失敗したファイルは配列に含めない (エラー通知は App のトーストが担う)。
   */
  uploadFiles: (files: File[]) => Promise<string[]>;
  /** ドロップオーバーレイの表示切替 */
  setDragActive: (active: boolean) => void;
}

export const uploadEnvFacet = Facet.define<UploadEnv, UploadEnv | null>({
  combine: (values) => values[0] ?? null,
});

function filesOf(dt: DataTransfer | null): File[] {
  if (dt === null) return [];
  return Array.from(dt.files);
}

/** DataTransfer にファイルが含まれるか (drag 中は files が空なので types で判定)。 */
function containsFiles(dt: DataTransfer | null): boolean {
  if (dt === null) return false;
  return Array.from(dt.types).includes('Files');
}

/** アップロード完了後に ![[パス]] 群をドキュメントへ挿入する。 */
async function uploadAndInsert(
  view: EditorView,
  env: UploadEnv,
  files: File[],
  posHint: number | null,
): Promise<void> {
  const paths = await env.uploadFiles(files);
  if (paths.length === 0) return;
  const doc = view.state.doc;
  const pos = Math.min(posHint ?? view.state.selection.main.head, doc.length);
  const text = paths.map((p) => `![[${p}]]`).join('\n');
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

export function uploadExtension(): Extension {
  return EditorView.domEventHandlers({
    dragover(event, view) {
      const env = view.state.facet(uploadEnvFacet);
      if (env === null || !containsFiles(event.dataTransfer)) return false;
      event.preventDefault(); // ドロップを受け付ける宣言 (既定はブラウザがファイルを開く)
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      env.setDragActive(true);
      return true;
    },
    dragleave(event, view) {
      const env = view.state.facet(uploadEnvFacet);
      if (env === null) return false;
      // エディタ外へ出たときだけ消す (子要素間の移動では relatedTarget が内側)
      const related = event.relatedTarget;
      if (related instanceof Node && view.dom.contains(related)) return false;
      env.setDragActive(false);
      return false;
    },
    drop(event, view) {
      const env = view.state.facet(uploadEnvFacet);
      if (env === null) return false;
      env.setDragActive(false);
      const files = filesOf(event.dataTransfer);
      if (files.length === 0) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      void uploadAndInsert(view, env, files, pos);
      return true;
    },
    paste(event, view) {
      const env = view.state.facet(uploadEnvFacet);
      if (env === null) return false;
      const files = filesOf(event.clipboardData);
      if (files.length === 0) return false; // テキスト貼り付けは通常処理へ
      event.preventDefault();
      void uploadAndInsert(view, env, files, view.state.selection.main.head);
      return true;
    },
  });
}
