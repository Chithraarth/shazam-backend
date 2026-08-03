import { GoogleGenAI } from "@google/genai";

if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_GEMINI_API_KEY must be set.",
  );
}

// Leave AI_INTEGRATIONS_GEMINI_BASE_URL unset to use the default Google
// Generative Language API endpoint; only override it when pointing at a
// custom-hosted/proxied Gemini endpoint.
export const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  ...(process.env.AI_INTEGRATIONS_GEMINI_BASE_URL
    ? { httpOptions: { apiVersion: "", baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL } }
    : {}),
});
