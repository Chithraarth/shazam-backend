import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import healthRouter from "./health";
import identifyRouter from "./identify";
import historyRouter from "./history";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth, usersRouter);
router.use(requireAuth, identifyRouter);
router.use(requireAuth, historyRouter);

export default router;
