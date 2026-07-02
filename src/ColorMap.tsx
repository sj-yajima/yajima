import { useEffect, useMemo, useRef, useState } from "react";
import Plotly from "plotly.js-dist-min";
import WC from "wordcloud";

// Python（UMAP）側で前計算した各点。Excel は読まない。
export type PlotPoint = {
  id: number;
  name: string;
  hex: string;
  description: string;
  description_wrap?: string;
  umap: { x: number; y: number; z: number };
  topic?: number; // bertopic_assignments.json から id で結合
};

// BERTopic のトピック情報（bertopic_topic_info.json）
export type TopicInfo = {
  topic: number;
  count: number;
  name: string;
  topWords: string[];
};

// 代表語のスコア（topic_word_scores.json）: ワードクラウドの重みに使う
export type WordScore = {
  topic: number;
  rank: number;
  word: string;
  c_tf_idf: number;
};

// 既定の取得先（public/data/ に置く）
const DATA_URL = "/data/iiro_jis_264colors 2_plot_data.json";
const ASSIGN_URL = "/data/bertopic_assignments.json";
const TOPICINFO_URL = "/data/bertopic_topic_info.json";
const WORDSCORES_URL = "/data/topic_word_scores.json";

type BgKey = "dark" | "gray" | "light";

const BG_PRESETS: Record<BgKey, { paper: string; axisBg: string; grid: string }> =
  {
    // 真っ黒だと黒系の点が沈むので、暗いがほんの少し持ち上げたチャコールにする。
    dark: { paper: "#2c2c34", axisBg: "#24242b", grid: "#3d3d47" },
    gray: { paper: "#7f7f87", axisBg: "#73737c", grid: "#9a9aa3" },
    light: { paper: "#ffffff", axisBg: "#f4f4f7", grid: "#d8d8e0" },
  };

const CONFIG = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  displayModeBar: true,
};

const INITIAL_CAMERA = { eye: { x: 1.6, y: 1.6, z: 1.1 } };

type Ranges = {
  x: [number, number];
  y: [number, number];
  z: [number, number];
};

// 各軸を「最大スパン」に揃えた等幅レンジにする（各軸データは中央寄せ）。
// これで aspectmode:"cube" と合わせると、歪みのない立方体になる（小さい軸は余白）。
function cubeRanges(points: PlotPoint[]): Ranges {
  const axis = (vals: number[]) => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return { center: (lo + hi) / 2, span: hi - lo };
  };
  const X = axis(points.map((p) => p.umap.x));
  const Y = axis(points.map((p) => p.umap.y));
  const Z = axis(points.map((p) => p.umap.z));
  const half = (Math.max(X.span, Y.span, Z.span) * 1.08 || 1) / 2;
  const r = (a: { center: number }): [number, number] => [
    a.center - half,
    a.center + half,
  ];
  return { x: r(X), y: r(Y), z: r(Z) };
}

// UMAP 軸は意味を持たないので目盛りは隠してすっきり見せる。
function buildLayout(bg: BgKey, camera: unknown, ranges: Ranges) {
  const p = BG_PRESETS[bg];
  const base = {
    showbackground: true,
    backgroundcolor: p.axisBg,
    gridcolor: p.grid,
    zerolinecolor: p.grid,
    showticklabels: false,
    title: { text: "" },
  };
  return {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    showlegend: false,
    paper_bgcolor: p.paper,
    scene: {
      xaxis: { ...base, range: ranges.x },
      yaxis: { ...base, range: ranges.y },
      zaxis: { ...base, range: ranges.z },
      aspectmode: "cube",
      bgcolor: p.paper,
      camera,
    },
  };
}

// クリック駆動にするため hover は無効（hoverinfo: "none"）。
function buildTraces(points: PlotPoint[], selected: PlotPoint | null, size: number) {
  const base = {
    type: "scatter3d",
    mode: "markers",
    x: points.map((p) => p.umap.x),
    y: points.map((p) => p.umap.y),
    z: points.map((p) => p.umap.z),
    customdata: points.map((p) => p.id),
    marker: {
      size,
      color: points.map((p) => p.hex),
      opacity: 0.95,
      line: { width: 0 },
    },
    hoverinfo: "none",
  };
  const traces: unknown[] = [base];
  if (selected) {
    traces.push({
      type: "scatter3d",
      mode: "markers",
      x: [selected.umap.x],
      y: [selected.umap.y],
      z: [selected.umap.z],
      customdata: [selected.id],
      marker: {
        size: Math.max(size + 6, 9),
        color: selected.hex,
        opacity: 1,
        line: { color: "#ffffff", width: 3 },
      },
      hoverinfo: "none",
    });
  }
  return traces;
}

// "['安心', '親しみ', ...]" のようなPythonリスト文字列 → 文字列配列
function parseWords(rep: string): string[] {
  const m = rep.match(/'([^']*)'/g);
  return m ? m.map((s) => s.slice(1, -1)) : [];
}

// ---- 再利用可能な 3D 散布図（メイン図・クラスタ図で共用） ----
function Scatter3D({
  points,
  activeId,
  size,
  bg,
  onPick,
  className,
}: {
  points: PlotPoint[];
  activeId: number | null;
  size: number;
  bg: BgKey;
  onPick: (id: number) => void;
  className: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const cameraRef = useRef<unknown>(INITIAL_CAMERA);

  useEffect(() => {
    const div = ref.current;
    if (!div || points.length === 0) return;
    const activePoint =
      activeId == null ? null : points.find((p) => p.id === activeId) ?? null;
    Plotly.react(
      div,
      buildTraces(points, activePoint, size),
      buildLayout(bg, cameraRef.current, cubeRanges(points)),
      CONFIG
    );
    const gd = div as unknown as {
      __bound?: boolean;
      on: (ev: string, cb: (e: unknown) => void) => void;
    };
    if (!gd.__bound) {
      gd.on("plotly_click", (e: unknown) => {
        const ev = e as { points?: Array<{ customdata?: number }> };
        const id = ev.points?.[0]?.customdata;
        if (id != null) onPickRef.current(id);
      });
      gd.on("plotly_relayout", (e: unknown) => {
        const ev = e as Record<string, unknown>;
        if (ev["scene.camera"]) cameraRef.current = ev["scene.camera"];
      });
      gd.__bound = true;
    }
  }, [points, activeId, size, bg]);

  useEffect(() => {
    const div = ref.current;
    if (!div) return;
    const ro = new ResizeObserver(() => {
      try {
        Plotly.Plots.resize(div);
      } catch {
        /* noop */
      }
    });
    ro.observe(div);
    return () => {
      ro.disconnect();
      try {
        Plotly.purge(div);
      } catch {
        /* noop */
      }
    };
  }, []);

  return (
    <div
      className={className}
      ref={ref}
      style={{ background: BG_PRESETS[bg].paper }}
    />
  );
}

// ---- パック型ワードクラウド（wordcloud2/canvas） ----
function WordCloud({ words }: { words: { word: string; score: number }[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const parent = canvas.parentElement;
      // 親（.cloud-canvas-wrap）の実サイズいっぱいに描く。
      const cw = Math.max(parent?.clientWidth ?? 320, 200);
      const ch = Math.max(parent?.clientHeight ?? 240, 150);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = cw + "px";
      canvas.style.height = ch + "px";

      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      if (words.length === 0) return;

      const scores = words.map((w) => w.score);
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const norm = (s: number) => (max > min ? (s - min) / (max - min) : 0.5);
      // 箱の高さに合わせてフォントサイズ域を決める（余白が出にくい）。
      const maxFont = Math.min(Math.max(ch * 0.22, 26), 60);
      const minFont = maxFont * 0.42;
      const list = words.map(
        (w) =>
          [w.word, minFont + norm(w.score) * (maxFont - minFont)] as [
            string,
            number
          ]
      );
      const palette = [
        "#2c7fb8",
        "#41ab5d",
        "#c9a400",
        "#4f46e5",
        "#0f7d92",
        "#7048a0",
        "#2a9d8f",
        "#b8621b",
      ];
      let i = 0;

      WC(canvas, {
        list,
        gridSize: Math.round(6 * dpr),
        weightFactor: (wt: number) => wt * dpr,
        fontFamily: "Inter, system-ui, sans-serif",
        color: () => palette[i++ % palette.length],
        rotateRatio: 0,
        backgroundColor: "transparent",
        drawOutOfBound: false,
        shrinkToFit: true,
      });
    };

    draw();
    const ro = new ResizeObserver(() => draw());
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, [words]);

  return <canvas ref={canvasRef} className="word-cloud-canvas" />;
}

export default function ColorMap() {
  const [points, setPoints] = useState<PlotPoint[]>([]);
  const [topicInfo, setTopicInfo] = useState<TopicInfo[]>([]);
  const [wordScores, setWordScores] = useState<WordScore[]>([]);
  // 詳細パネルは直近2件を保持（[0]=最新, [1]=ひとつ前）。
  const [history, setHistory] = useState<PlotPoint[]>([]);
  // 拡大表示中の点の id（同じ点を再クリックで解除＝null）。
  const [activeId, setActiveId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [bg, setBg] = useState<BgKey>("gray");
  const [size, setSize] = useState(2);
  const [clusterSize, setClusterSize] = useState(2);

  const pointsRef = useRef<PlotPoint[]>([]);
  pointsRef.current = points;
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  // ---- 自動読み込み（plot + topic割当 + topic情報） ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [plotRes, assignRes, topicRes, scoreRes] = await Promise.all([
          fetch(DATA_URL),
          fetch(ASSIGN_URL),
          fetch(TOPICINFO_URL),
          fetch(WORDSCORES_URL),
        ]);
        if (!plotRes.ok) throw new Error(`HTTP ${plotRes.status}`);
        const base = (await plotRes.json()) as PlotPoint[];

        // topic を id で結合
        let topicById = new Map<number, number>();
        if (assignRes.ok) {
          const assigns = (await assignRes.json()) as Array<{
            id: number;
            topic: number;
          }>;
          topicById = new Map(assigns.map((a) => [a.id, a.topic]));
        }
        const merged = base.map((p) => ({ ...p, topic: topicById.get(p.id) }));

        // topic 情報
        let infos: TopicInfo[] = [];
        if (topicRes.ok) {
          const raw = (await topicRes.json()) as Array<{
            Topic: number;
            Count: number;
            Name: string;
            Representation: string;
          }>;
          infos = raw.map((t) => ({
            topic: t.Topic,
            count: t.Count,
            name: t.Name,
            topWords: parseWords(t.Representation),
          }));
        }

        // 代表語スコア（ワードクラウド用）
        let scores: WordScore[] = [];
        if (scoreRes.ok) {
          scores = (await scoreRes.json()) as WordScore[];
        }

        if (!cancelled) {
          setPoints(merged);
          setTopicInfo(infos);
          setWordScores(scores);
          setError("");
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            `自動読み込みに失敗しました（${
              e instanceof Error ? e.message : String(e)
            }）。下のボタンでJSONを選ぶか、public/data/ に配置してください。`
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 手動読み込み（plot JSON のみ・topicなし） ----
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const json = JSON.parse(await f.text()) as PlotPoint[];
      setPoints(json);
      setHistory([]);
      setActiveId(null);
      setError("");
    } catch (err) {
      setError(
        "JSONの読み込みに失敗: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  // ---- 点の選択（トグル + 直近2件） ----
  const handlePick = (id: number) => {
    // 拡大中の点を再クリック → 拡大解除（詳細・クラスタ表示は残す）。
    if (activeIdRef.current === id) {
      setActiveId(null);
      return;
    }
    setActiveId(id);
    const p = pointsRef.current.find((pt) => pt.id === id);
    if (p) {
      setHistory((prev) => [p, ...prev.filter((q) => q.id !== p.id)].slice(0, 2));
    }
  };

  // ---- クラスタ探索用の派生値 ----
  const topicMap = useMemo(
    () => new Map(topicInfo.map((t) => [t.topic, t])),
    [topicInfo]
  );
  // 最新クリック点の topic を「表示中クラスタ」とする。
  const selectedTopic = history[0]?.topic ?? null;
  const clusterPoints = useMemo(
    () =>
      selectedTopic == null
        ? []
        : points.filter((p) => p.topic === selectedTopic),
    [points, selectedTopic]
  );
  const topicMeta =
    selectedTopic == null ? undefined : topicMap.get(selectedTopic);

  // topic -> [{word, score}]（rank順）
  const wordCloudMap = useMemo(() => {
    const m = new Map<number, { word: string; score: number }[]>();
    for (const w of wordScores) {
      const arr = m.get(w.topic) ?? [];
      arr.push({ word: w.word, score: w.c_tf_idf });
      m.set(w.topic, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => b.score - a.score);
    return m;
  }, [wordScores]);
  const cloudWords =
    selectedTopic == null ? [] : wordCloudMap.get(selectedTopic) ?? [];

  return (
    <>
      {/* ===== 上段: 全体の3D + 詳細 ===== */}
      <div className="map-wrap">
        <div className="map-main">
          <div className="map-toolbar">
            <span className="note" style={{ margin: 0 }}>
              {loading
                ? "読み込み中…"
                : points.length > 0
                ? `${points.length} 点 — 点をクリックすると下にクラスタを表示`
                : "データ未読み込み"}
            </span>

            <div className="map-controls">
              <div className="seg" role="group" aria-label="背景色">
                <button
                  className={bg === "dark" ? "seg-on" : ""}
                  onClick={() => setBg("dark")}
                >
                  黒
                </button>
                <button
                  className={bg === "gray" ? "seg-on" : ""}
                  onClick={() => setBg("gray")}
                >
                  グレー
                </button>
                <button
                  className={bg === "light" ? "seg-on" : ""}
                  onClick={() => setBg("light")}
                >
                  白
                </button>
              </div>

              <label className="size-ctrl">
                点サイズ
                <input
                  type="range"
                  min={0.5}
                  max={12}
                  step={0.5}
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                />
                <span>{size}</span>
              </label>

              <label className="file-inline">
                JSONを選択
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={onFile}
                  style={{ display: "none" }}
                />
              </label>
            </div>
          </div>

          {error && <p className="note warn">{error}</p>}
          <Scatter3D
            points={points}
            activeId={activeId}
            size={size}
            bg={bg}
            onPick={handlePick}
            className="map-plot"
          />
        </div>

        <aside className="map-panel panel">
          <h2>詳細</h2>
          {history.length === 0 ? (
            <p className="note">点をクリックしてください。</p>
          ) : (
            history.map((p, i) => (
              <div
                key={p.id}
                className={"detail" + (i > 0 ? " detail-prev" : "")}
              >
                {i > 0 && <div className="detail-tag">ひとつ前</div>}
                <div className="detail-head">
                  <span
                    className="swatch"
                    style={{ background: p.hex }}
                    aria-hidden
                  />
                  <div>
                    <div className="detail-name">{p.name}</div>
                    <div className="detail-hex">{p.hex}</div>
                  </div>
                </div>
                <p className="detail-desc">{p.description}</p>
                <p className="hint">
                  id: {p.id}
                  {p.topic != null && ` ／ topic: ${p.topic}`}
                </p>
              </div>
            ))
          )}
        </aside>
      </div>

      {/* ===== 下段: 選択点が属するクラスタ ===== */}
      {selectedTopic != null && (
        <div className="cluster-section">
          <div className="cluster-head">
            <h2 style={{ margin: 0 }}>
              クラスタ {selectedTopic}
              {selectedTopic === -1 && "（外れ値）"}
            </h2>
            <span className="note" style={{ margin: 0 }}>
              {clusterPoints.length} 色
            </span>
          </div>

          <div className="cluster-body">
            <div className="cluster-plot-wrap">
              <div className="map-toolbar">
                <span className="note" style={{ margin: 0 }}>
                  点をクリックで選択
                </span>
                <div className="map-controls">
                  <label className="size-ctrl">
                    点サイズ
                    <input
                      type="range"
                      min={0.5}
                      max={12}
                      step={0.5}
                      value={clusterSize}
                      onChange={(e) => setClusterSize(Number(e.target.value))}
                    />
                    <span>{clusterSize}</span>
                  </label>
                </div>
              </div>
              <Scatter3D
                points={clusterPoints}
                activeId={activeId}
                size={clusterSize}
                bg={bg}
                onPick={handlePick}
                className="cluster-plot"
              />
            </div>

            <div className="cluster-side">
              <div className="panel cluster-words">
                <h3>代表語</h3>
                {topicMeta && topicMeta.topWords.length > 0 ? (
                  <div className="word-tags">
                    {topicMeta.topWords.map((w, i) => (
                      <span key={i} className="word-tag">
                        {w}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="note">（代表語なし）</p>
                )}
              </div>

              <div className="panel cluster-cloud">
                <h3>ワードクラウド</h3>
                <div className="cloud-canvas-wrap">
                  {cloudWords.length > 0 ? (
                    <WordCloud words={cloudWords} />
                  ) : (
                    <p className="note">（スコアなし）</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 色一覧：全幅グリッドで一度に多数表示 */}
          <div className="panel cluster-colors-wide">
            <h3>この色一覧（{clusterPoints.length}）</h3>
            <div className="color-grid">
              {clusterPoints.map((p) => (
                <div
                  key={p.id}
                  className={"color-card" + (p.id === activeId ? " active" : "")}
                  onClick={() => handlePick(p.id)}
                >
                  <div className="color-card-head">
                    <span
                      className="swatch-sm"
                      style={{ background: p.hex }}
                      aria-hidden
                    />
                    <strong>{p.name}</strong>
                    <span className="detail-hex">{p.hex}</span>
                  </div>
                  <div className="color-row-desc">{p.description}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
