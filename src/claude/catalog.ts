// Models as the Claude desktop app's model picker lists them. The app caches its catalog at
// ~/.claude/cache/model-catalog/*-ccd.json (surface "ccd" = Claude desktop), with per-model effort options.
// Internal cache file, read-only; falls back to the documented aliases when it's missing.

import fs from "node:fs";
import path from "node:path";
import type { ModelInfo } from "../types.ts";
import { modelCatalogDir } from "./paths.ts";

const FALLBACK: ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", shortName: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"], fast: false },
  { id: "claude-fable-5-1", name: "Fable 5.1", shortName: "Fable", efforts: ["low", "medium", "high", "xhigh", "max"], fast: false },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", shortName: "Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"], fast: false },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", shortName: "Haiku", efforts: [], fast: false },
];

interface RawModel {
  id?: string;
  name?: string;
  short_name?: string;
  section?: string;
  thinking?: { type?: string; effort_options?: Array<{ id?: string }> };
  /** Present (type "toggle") only on models that offer fast mode. */
  fast_mode?: { type?: string };
}

export function parseCatalog(json: unknown): ModelInfo[] {
  const models = (json as { catalog?: { config?: { models?: RawModel[] } } })?.catalog?.config?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => m && typeof m.id === "string" && (m.section ?? "main") === "main")
    .map((m) => ({
      id: m.id!,
      name: m.name ?? m.id!,
      shortName: m.short_name ?? m.name ?? m.id!,
      efforts: m.thinking?.type === "effort" ? (m.thinking.effort_options ?? []).map((o) => o.id).filter((x): x is string => typeof x === "string") : [],
      fast: !!m.fast_mode && typeof m.fast_mode === "object",
    }));
}

let cache: { at: number; models: ModelInfo[] } | undefined;

export function loadModels(now = Date.now()): ModelInfo[] {
  if (cache && now - cache.at < 60_000) return cache.models;
  let models: ModelInfo[] = [];
  try {
    const files = fs
      .readdirSync(modelCatalogDir())
      .filter((f) => f.endsWith("-ccd.json"))
      .map((f) => path.join(modelCatalogDir(), f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files) {
      models = parseCatalog(JSON.parse(fs.readFileSync(f, "utf8")));
      if (models.length) break;
    }
  } catch {
    // no cache yet
  }
  if (!models.length) models = FALLBACK;
  cache = { at: now, models };
  return models;
}

/**
 * Is `id` the catalog model `base`? Only an exact id, or one that differs by a context suffix ("[1m]") or a date
 * ("-20251001", either side). Never by family name: the app's other models ("claude-fable-5", "claude-opus-4-8") are
 * different models, not the main ones.
 */
export function sameModelId(id: string, base: string): boolean {
  if (id === base) return true;
  if (id.startsWith(base)) return /^(-\d{8})?(\[[^\]]*\])?$/.test(id.slice(base.length));
  if (base.startsWith(id)) return /^-\d{8}$/.test(base.slice(id.length));
  return false;
}

/** The main-menu model an id names (see sameModelId), or undefined for any other model. */
export function modelInfo(id: string | undefined, models = loadModels()): ModelInfo | undefined {
  if (!id) return undefined;
  return models.find((m) => m.id === id) ?? models.find((m) => sameModelId(id, m.id));
}

/** Display name for a model id: "Opus 5.5". */
export function modelName(id: string | undefined, models = loadModels()): string {
  if (!id) return "Model";
  const m = modelInfo(id, models);
  if (m) return m.name;
  const g = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  return g ? `${g[1]![0]!.toUpperCase()}${g[1]!.slice(1)} ${g[2]}${g[3] ? `.${g[3]}` : ""}` : id;
}

export const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max", ultracode: "Ultra" };

// ── Defaults shared by the keys, the Property Inspectors and ops.ts (one source of truth) ─────────────────

/** Model slots a Model key cycles through when it has none configured: Fable 5.1, then Opus 5.5. */
export const DEFAULT_MODEL_SLOTS: readonly string[] = ["claude-fable-5-1", "claude-opus-5-5"];

/** Effort levels assumed for a model that isn't in the app's catalog. */
export const DEFAULT_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Every stop an Effort key can step through, in slider order (Ultracode last) — its default cycle. */
export const DEFAULT_EFFORT_CYCLE: readonly string[] = [...DEFAULT_EFFORTS, "ultracode"];

/**
 * Stops of the app's effort slider for a model, left to right: its effort levels, then "ultracode". Empty for a
 * model without an effort setting (Haiku); DEFAULT_EFFORTS + Ultracode for a model the catalog doesn't know.
 */
export function effortStopsFor(info: ModelInfo | undefined): string[] {
  const efforts = (info ? info.efforts : DEFAULT_EFFORTS).filter((e) => e !== "ultracode");
  return efforts.length ? [...efforts, "ultracode"] : [];
}
