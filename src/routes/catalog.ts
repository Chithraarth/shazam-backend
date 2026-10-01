import { Router, type IRouter } from "express";
import { lookupPerson, lookupSeason, tmdbEnabled } from "../lib/tmdb";

const router: IRouter = Router();

const posInt = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 1e9 ? n : null;
};

router.get("/catalog/person/:id", async (req, res) => {
  const id = posInt(req.params.id);
  if (id === null) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!tmdbEnabled()) { res.status(503).json({ error: "Catalog unavailable" }); return; }
  const person = await lookupPerson(id);
  if (!person) { res.status(404).json({ error: "Not found" }); return; }
  res.json(person);
});

router.get("/catalog/tv/:id/season/:season", async (req, res) => {
  const id = posInt(req.params.id);
  const season = posInt(req.params.season);
  if (id === null || season === null) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!tmdbEnabled()) { res.status(503).json({ error: "Catalog unavailable" }); return; }
  const data = await lookupSeason(id, season);
  if (!data) { res.status(404).json({ error: "Not found" }); return; }
  res.json(data);
});

export default router;
