import { randomUUID } from "node:crypto";

import { CATEGORIES } from "./constants.js";

const normalizeText = (value) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

export function validatePoll(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const question = normalizeText(input.question);
  const category = normalizeText(input.category);
  const options = Array.isArray(input.options)
    ? input.options.map(normalizeText).filter(Boolean)
    : [];
  const errors = [];

  if (question.length < 5 || question.length > 240) {
    errors.push("Question must be between 5 and 240 characters");
  }
  if (!CATEGORIES.includes(category)) errors.push("Choose a valid category");
  if (options.length < 2 || options.length > 6) {
    errors.push("Add between 2 and 6 options");
  }
  if (options.some((option) => option.length > 100)) {
    errors.push("Options cannot exceed 100 characters");
  }
  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
    errors.push("Options must be unique");
  }

  return { errors, value: { question, category, options } };
}

export function createSlug(question) {
  const base = question
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 55)
    .replace(/-$/, "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return `${base || "poll"}-${suffix}`;
}
