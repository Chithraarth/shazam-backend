import { Router, type IRouter } from "express";
import { requireAuth, requirePayment } from "../middlewares/auth";
import healthRouter from "./health";
import identifyRouter from "./identify";
import historyRouter from "./history";
import stripeRouter from "./stripe";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth, usersRouter);
router.use(requireAuth, stripeRouter);
router.use(requireAuth, identifyRouter);
router.use(requireAuth, requirePayment, historyRouter);

export default router;
