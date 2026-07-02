// plotly.js-dist-min は型定義を同梱しないため、最小限の宣言を与える（中身は any）。
declare module "plotly.js-dist-min" {
  const Plotly: {
    newPlot: (...args: unknown[]) => Promise<unknown>;
    react: (...args: unknown[]) => Promise<unknown>;
    purge: (el: unknown) => void;
    Plots: { resize: (el: unknown) => void };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  export default Plotly;
}
