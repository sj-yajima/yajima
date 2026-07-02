import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import { fetchAuthSession } from "aws-amplify/auth";
import { AwsClient } from "aws4fetch";
import ExcelJS from "exceljs";
import outputs from "../amplify_outputs.json";

// 3D可視化ビューはPlotlyが重いので、タブを開いたときだけ遅延ロードする。
const ColorMap = lazy(() => import("./ColorMap"));

// ---------- Bedrock Function URL (amplify_outputs.json の custom 配下) ----------
const FUNCTION_URL: string | undefined = (
  outputs as { custom?: { bedrockFunctionUrl?: string } }
).custom?.bedrockFunctionUrl;
// 署名は Function URL のリージョン（=デプロイ先リージョン）で行う。
const SIGN_REGION =
  FUNCTION_URL?.match(/\.lambda-url\.([^.]+)\.on\.aws/)?.[1] ?? "ap-northeast-1";

// ---------- Bedrock モデルID候補（Opus 4.8 のみ） ----------
// jp.=日本内推論 / global.=グローバル推論。どちらも Opus 4.8。
const MODEL_SUGGESTIONS = [
  "jp.anthropic.claude-opus-4-8",
];
const DEFAULT_MODEL = MODEL_SUGGESTIONS[0];

const DEFAULT_SYSTEM =
  "あなたは正確かつ簡潔に回答するアシスタントです。前置きや余計な説明はせず、質問への答えだけを返してください。";

const DEFAULT_TEMPLATE = `次の色が見る人の心に呼び起こす「印象・気分・雰囲気」を、100字程度で述べてください。

厳守事項:
・回答は最初から最後まで「受け手の感じ方（印象）」だけを書く。色の見た目を説明するのではなく、その色が人の心にどう作用し、何を感じさせるかを述べる。
・印象は次の観点で具体的に掘り下げる：
   - 喚起する気分・感情（落ち着く/高揚する/緊張する/安心する/寂しい 等）
   - 漂う雰囲気・ムード（静謐/賑やか/厳か/親密/開放的 等）
   - 感じさせる人柄・性格・態度（誠実/大胆/控えめ/優雅/快活 等）
   - 品位と格（上品/素朴、フォーマル/カジュアル）、時代感（伝統的/現代的）、活動性（静的/動的）
・色名や色みを表す語を使わない（対象色名「{{色名}}」、他の色名、「赤み」「青っぽい」等の派生も禁止）。
・その色を連想させる具体物・情景・自然物に例えない（空・海・水・森・草・炎・火・血・太陽・夕日・夜 など。読み手が色を当てられる手がかりを書かない）。
・肯定文のみ。否定（〜ではない）や比較（〜のような）は使わない。

色名: {{色名}}
カラーコード: {{コード}}`;

const DEFAULT_OUTPUT_COL = "説明";

// 起動時にバッチ結果テーブルへ自動表示する「前回の完成ファイル」。
// public/data/ にある実ファイルを指す（別ファイルにしたい場合はここを変更）。
const DEFAULT_BATCH_URL = "/data/iiro_jis_264colors 2_結果.xlsx";

// ---------- Bedrock 呼び出し（SigV4署名付き fetch） ----------
async function askBedrock(body: {
  prompt: string;
  system?: string;
  modelId: string;
  maxTokens: number;
}): Promise<string> {
  if (!FUNCTION_URL) {
    throw new Error(
      "関数URLが未設定です。`npx ampx sandbox` でバックエンドをデプロイしてください。"
    );
  }
  const session = await fetchAuthSession();
  const c = session.credentials;
  if (!c) {
    throw new Error("AWS認証情報を取得できません。再ログインしてください。");
  }
  const aws = new AwsClient({
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
    service: "lambda",
    region: SIGN_REGION,
  });
  const res = await aws.fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.text ?? "";
}

// ---------- localStorage helper ----------
function useStored(key: string, initial: string) {
  const [value, setValue] = useState<string>(
    () => localStorage.getItem(key) ?? initial
  );
  const set = (v: string) => {
    setValue(v);
    localStorage.setItem(key, v);
  };
  return [value, set] as const;
}

// ---------- CSV parsing (RFC 4180-ish) ----------
function parseCSV(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r") {
      i++;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function toCSV(headers: string[], rows: string[][]): string {
  const esc = (v: string) => {
    const s = v ?? "";
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(",")];
  for (const r of rows) lines.push(r.map(esc).join(","));
  return lines.join("\r\n");
}

// ---------- {{column}} substitution ----------
function fillTemplate(
  template: string,
  headers: string[],
  row: string[]
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, name) => {
    const idx = headers.indexOf(String(name).trim());
    return idx >= 0 ? row[idx] ?? "" : whole;
  });
}

// ---------- limited-concurrency map ----------
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
) {
  let next = 0;
  const runner = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      await worker(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runner)
  );
}

type Cell = { status: "pending" | "done" | "error"; text: string };
type Format = "xlsx" | "csv";

function App() {
  const { user, signOut } = useAuthenticator();

  // 前回開いていたタブを記憶する（リロードで勝手に切り替わらない）。
  const [view, setView] = useStored("cb_view", "batch");

  const [model, setModel] = useStored("cb_bedrock_model3", DEFAULT_MODEL);
  const [system, setSystem] = useStored("cb_system", DEFAULT_SYSTEM);
  const [template, setTemplate] = useStored("cb_tpl_color4", DEFAULT_TEMPLATE);
  const [outputCol, setOutputCol] = useStored(
    "cb_outcol_color",
    DEFAULT_OUTPUT_COL
  );
  const [maxTokens, setMaxTokens] = useStored("cb_maxTokens", "1024");
  const [concurrency, setConcurrency] = useStored("cb_concurrency", "5");

  const [fileName, setFileName] = useState("");
  const [format, setFormat] = useState<Format>("xlsx");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [results, setResults] = useState<Cell[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [topError, setTopError] = useState("");

  const templateRef = useRef<HTMLTextAreaElement>(null);
  const workbookRef = useRef<ExcelJS.Workbook | null>(null);
  const rowNumbersRef = useRef<number[]>([]); // excel source row index per data row

  // ---- file load ----
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setTopError("");
    setResults([]);
    setDone(0);
    workbookRef.current = null;
    rowNumbersRef.current = [];

    const isExcel = /\.(xlsx|xlsm)$/i.test(file.name);
    try {
      if (isExcel) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const ws = wb.worksheets[0];
        if (!ws) throw new Error("シートが見つかりません。");
        const headerRow = ws.getRow(1);
        const colCount = Math.max(headerRow.cellCount, headerRow.actualCellCount);
        const hdrs: string[] = [];
        for (let c = 1; c <= colCount; c++) {
          hdrs.push(headerRow.getCell(c).text.trim());
        }
        const data: string[][] = [];
        const rowNums: number[] = [];
        for (let r = 2; r <= ws.rowCount; r++) {
          const xr = ws.getRow(r);
          const vals: string[] = [];
          for (let c = 1; c <= colCount; c++) vals.push(xr.getCell(c).text);
          if (vals.some((v) => v.trim() !== "")) {
            data.push(vals);
            rowNums.push(r);
          }
        }
        if (hdrs.length === 0 || data.length === 0) {
          throw new Error("ヘッダー行 + データ行が1行以上必要です。");
        }
        workbookRef.current = wb;
        rowNumbersRef.current = rowNums;
        setFormat("xlsx");
        setHeaders(hdrs);
        setRows(data);
      } else {
        const parsed = parseCSV(await file.text());
        if (parsed.length < 2) {
          throw new Error("ヘッダー行 + データ行が1行以上必要です。");
        }
        setFormat("csv");
        setHeaders(parsed[0]);
        setRows(parsed.slice(1));
      }
      setFileName(file.name);
    } catch (err) {
      setTopError(
        "読み込みに失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
      setHeaders([]);
      setRows([]);
    }
  };

  // ---- 起動時に「前回の完成ファイル」を自動表示（無ければ空のまま） ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(DEFAULT_BATCH_URL);
        if (!res.ok) return;
        const isExcel = /\.(xlsx|xlsm)$/i.test(DEFAULT_BATCH_URL);
        let hdrs: string[] = [];
        let data: string[][] = [];
        if (isExcel) {
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(await res.arrayBuffer());
          const ws = wb.worksheets[0];
          if (!ws) return;
          const headerRow = ws.getRow(1);
          const colCount = Math.max(
            headerRow.cellCount,
            headerRow.actualCellCount
          );
          for (let c = 1; c <= colCount; c++) {
            hdrs.push(headerRow.getCell(c).text.trim());
          }
          const rowNums: number[] = [];
          for (let r = 2; r <= ws.rowCount; r++) {
            const xr = ws.getRow(r);
            const vals: string[] = [];
            for (let c = 1; c <= colCount; c++) vals.push(xr.getCell(c).text);
            if (vals.some((v) => v.trim() !== "")) {
              data.push(vals);
              rowNums.push(r);
            }
          }
          if (cancelled) return;
          workbookRef.current = wb;
          rowNumbersRef.current = rowNums;
          setFormat("xlsx");
        } else {
          const parsed = parseCSV(await res.text());
          if (parsed.length < 2) return;
          hdrs = parsed[0];
          data = parsed.slice(1);
          if (cancelled) return;
          setFormat("csv");
        }
        if (hdrs.length === 0 || data.length === 0 || cancelled) return;
        // 「説明」列を生成済み(done)として結果に流し込む。
        const idx = hdrs.indexOf(DEFAULT_OUTPUT_COL);
        const cells: Cell[] =
          idx >= 0
            ? data.map((r) => ({ status: "done" as const, text: r[idx] ?? "" }))
            : [];
        setHeaders(hdrs);
        setRows(data);
        setFileName(DEFAULT_BATCH_URL.split("/").pop() || "");
        setResults(cells);
        setDone(cells.length);
      } catch {
        /* 既定ファイルが無ければ何もしない（空表示のまま） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- insert {{column}} into the template at the cursor ----
  const insertColumn = (col: string) => {
    const token = `{{${col}}}`;
    const ta = templateRef.current;
    if (!ta) {
      setTemplate(template + token);
      return;
    }
    const start = ta.selectionStart ?? template.length;
    const end = ta.selectionEnd ?? template.length;
    setTemplate(template.slice(0, start) + token + template.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const resetTemplate = () => {
    setTemplate(DEFAULT_TEMPLATE);
    setOutputCol(DEFAULT_OUTPUT_COL);
  };

  // ---- run ----
  const run = async () => {
    setTopError("");
    if (!model.trim()) return setTopError("BedrockのモデルIDを入力してください。");
    if (rows.length === 0) return setTopError("ファイルを読み込んでください。");
    if (!FUNCTION_URL)
      return setTopError(
        "関数URLが未設定です。`npx ampx sandbox` でデプロイしてください。"
      );

    setResults(rows.map(() => ({ status: "pending", text: "" })));
    setDone(0);
    setRunning(true);

    let completed = 0;
    const limit = Math.max(1, Math.min(20, parseInt(concurrency) || 5));
    const tokens = Math.max(1, parseInt(maxTokens) || 1024);

    await runPool(rows, limit, async (row, idx) => {
      const prompt = fillTemplate(template, headers, row);
      try {
        const text = await askBedrock({
          prompt,
          system: system.trim() || undefined,
          modelId: model.trim(),
          maxTokens: tokens,
        });
        setResults((prev) => {
          const copy = [...prev];
          copy[idx] = { status: "done", text: text.trim() };
          return copy;
        });
      } catch (err) {
        setResults((prev) => {
          const copy = [...prev];
          copy[idx] = {
            status: "error",
            text: err instanceof Error ? err.message : String(err),
          };
          return copy;
        });
      } finally {
        completed++;
        setDone(completed);
      }
    });

    setRunning(false);
  };

  // ---- download ----
  const outName = outputCol.trim() || DEFAULT_OUTPUT_COL;
  const existingIdx = headers.indexOf(outName);

  const download = async () => {
    const base = fileName.replace(/\.(xlsx|xlsm|csv)$/i, "");

    if (format === "xlsx" && workbookRef.current) {
      const wb = workbookRef.current;
      const ws = wb.worksheets[0];
      const colIndex = existingIdx >= 0 ? existingIdx + 1 : headers.length + 1;
      if (existingIdx < 0) ws.getRow(1).getCell(colIndex).value = outName;
      rows.forEach((_, i) => {
        ws.getRow(rowNumbersRef.current[i]).getCell(colIndex).value =
          results[i]?.text ?? "";
      });
      const buf = await wb.xlsx.writeBuffer();
      saveBlob(
        new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        base + "_結果.xlsx"
      );
    } else {
      const outHeaders = existingIdx >= 0 ? headers : [...headers, outName];
      const outRows = rows.map((r, i) => {
        const text = results[i]?.text ?? "";
        if (existingIdx >= 0) {
          const copy = [...r];
          copy[existingIdx] = text;
          return copy;
        }
        return [...r, text];
      });
      saveBlob(
        new Blob(["﻿" + toCSV(outHeaders, outRows)], {
          type: "text/csv;charset=utf-8;",
        }),
        base + "_結果.csv"
      );
    }
  };

  const saveBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---- derived ----
  const errorCount = results.filter((r) => r.status === "error").length;
  const allDone = results.length > 0 && done === results.length && !running;

  // 回答に入力値（色名・コードなど、出力列以外）が部分一致で混入していたら true。
  const isLeak = (cell: Cell | undefined, row: string[]) =>
    cell?.status === "done" &&
    row.some(
      (v, j) =>
        j !== existingIdx && v.trim() !== "" && cell.text.includes(v.trim())
    );
  const flaggedCount = results.reduce(
    (n, cell, i) => (isLeak(cell, rows[i]) ? n + 1 : n),
    0
  );

  const answerView = (cell: Cell | undefined) => {
    if (!cell || cell.status === "pending")
      return { text: "…", cls: "answer pending" };
    if (cell.status === "error")
      return { text: "エラー: " + cell.text, cls: "answer error" };
    return { text: cell.text, cls: "answer" };
  };

  return (
    <div className="app">
      <div className="statusline" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>Claudeの印象空間</h1>
        <span className="note" style={{ margin: 0 }}>
          {user?.signInDetails?.loginId}{" "}
          <button
            className="secondary"
            style={{ padding: "4px 12px", marginLeft: 8 }}
            onClick={signOut}
          >
            サインアウト
          </button>
        </span>
      </div>

      <div className="tabs">
        <button
          className={view === "batch" ? "" : "secondary"}
          onClick={() => setView("batch")}
        >
          バッチ生成
        </button>
        <button
          className={view === "map" ? "" : "secondary"}
          onClick={() => setView("map")}
        >
          3D可視化
        </button>
      </div>

      {view === "batch" && (
        <>
          <p className="subtitle">
            各行をプロンプトに差し込み、Lambda（Function URL）経由でAmazon
            Bedrock上のClaudeに問い合わせて、回答を指定列に書き込みます。
          </p>

      {/* settings */}
      <div className="panel">
        <h2>設定</h2>
        <div className="field">
          <label>
            Bedrock モデルID{" "}
            <span className="hint">
              （東京リージョン。Bedrockコンソールの正確なID/推論プロファイルIDを使用）
            </span>
          </label>
          <input
            type="text"
            list="model-suggestions"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="apac.anthropic.claude-..."
          />
          <datalist id="model-suggestions">
            {MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="note">
            呼び出しリージョンは <code>amplify/functions/bedrock/resource.ts</code>{" "}
            の <code>BEDROCK_REGION</code>（既定 ap-northeast-1）で変更できます。
          </p>
        </div>
        <details>
          <summary>詳細設定</summary>
          <div className="field">
            <label>
              システムプロンプト <span className="hint">（任意）</span>
            </label>
            <textarea
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              style={{ minHeight: 70 }}
            />
          </div>
          <div className="row">
            <div className="field">
              <label>
                最大トークン数 <span className="hint">（回答の長さ上限）</span>
              </label>
              <input
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </div>
            <div className="field">
              <label>
                同時実行数 <span className="hint">（1〜20）</span>
              </label>
              <input
                type="number"
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
              />
            </div>
          </div>
        </details>
      </div>

      {/* file */}
      <div className="panel">
        <h2>ファイル入力</h2>
        <div className="field">
          <label>
            Excel / CSV{" "}
            <span className="hint">（1行目をヘッダーとして扱います）</span>
          </label>
          <input
            type="file"
            accept=".xlsx,.xlsm,.csv,text/csv"
            onChange={onFile}
          />
        </div>
        {headers.length > 0 && (
          <p className="note">
            読み込み: <strong>{fileName}</strong>（{format.toUpperCase()}）—{" "}
            {rows.length}行 / 列: {headers.join("、")}
            {rows.length > 300 && (
              <span className="warn">
                {" "}
                ／ 300行を超えています。コストと時間にご注意ください。
              </span>
            )}
          </p>
        )}
      </div>

      {/* prompt */}
      <div className="panel">
        <h2>プロンプトテンプレート</h2>
        <div className="field">
          <label>
            プロンプト{" "}
            <span className="hint">
              {`{{列名}}`} の部分が各行の値に置き換わります
            </span>
          </label>
          <textarea
            ref={templateRef}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            style={{ minHeight: 130 }}
          />
          <div className="chips">
            <span className="hint" style={{ alignSelf: "center" }}>
              列を挿入:
            </span>
            {headers.map((h) => (
              <span
                key={h}
                className="chip"
                onClick={() => insertColumn(h)}
                title={`{{${h}}} を挿入`}
              >
                {`{{${h}}}`}
              </span>
            ))}
            <span
              className="chip"
              onClick={resetTemplate}
              style={{ background: "#fff" }}
              title="色イメージ用の初期テンプレートに戻す"
            >
              ↺ 初期値に戻す
            </span>
          </div>
        </div>
        <div className="field">
          <label>
            書き込む列名{" "}
            <span className="hint">
              {existingIdx >= 0
                ? "（既存の列に上書きします）"
                : "（新しい列として追加します）"}
            </span>
          </label>
          <input
            type="text"
            value={outputCol}
            onChange={(e) => setOutputCol(e.target.value)}
            style={{ maxWidth: 280 }}
          />
        </div>
        {rows.length > 0 && (
          <p className="note">
            1行目のプロンプト: {fillTemplate(template, headers, rows[0])}
          </p>
        )}
      </div>

      {/* run */}
      <div className="panel">
        <h2>実行</h2>
        <div className="statusline">
          <button onClick={run} disabled={running || rows.length === 0}>
            {running ? "処理中..." : "実行する"}
          </button>
          <button className="secondary" onClick={download} disabled={!allDone}>
            結果をダウンロード（{format.toUpperCase()}）
          </button>
          {results.length > 0 && (
            <span>
              {done} / {results.length} 完了
              {errorCount > 0 && (
                <span className="warn"> （エラー {errorCount}件）</span>
              )}
              {flaggedCount > 0 && (
                <span style={{ color: "#d6336c" }}>
                  {" "}／ 色名混入の疑い {flaggedCount}件
                </span>
              )}
            </span>
          )}
        </div>
        {topError && <p className="warn">{topError}</p>}
        {results.length > 0 && (
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${(done / results.length) * 100}%` }}
            />
          </div>
        )}

        {results.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {headers.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                  {existingIdx < 0 && <th>{outName}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const cell = results[i];
                  const view = answerView(cell);
                  const flagged = isLeak(cell, row);
                  const cls = view.cls + (flagged ? " flag" : "");
                  const title = flagged
                    ? "入力値（色名など）が説明文に含まれています"
                    : undefined;
                  return (
                    <tr key={i}>
                      {row.map((v, j) =>
                        j === existingIdx ? (
                          <td key={j} className={cls} title={title}>
                            {view.text}
                          </td>
                        ) : (
                          <td key={j}>{v}</td>
                        )
                      )}
                      {existingIdx < 0 && (
                        <td className={cls} title={title}>
                          {view.text}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </>
      )}

      {view === "map" && (
        <Suspense
          fallback={<p className="note">3Dビューを読み込み中…</p>}
        >
          <ColorMap />
        </Suspense>
      )}
    </div>
  );
}

export default App;
