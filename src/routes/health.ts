import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "../schemas";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Public. Lets the app force an update when an old build must stop working
// (e.g. after a breaking API change). Unset = no minimum.
router.get("/app-config", (_req, res) => {
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  res.json({
    minAndroidVersionCode: num(process.env.MIN_ANDROID_VERSION_CODE),
    minIosBuild: num(process.env.MIN_IOS_BUILD),
  });
});

export default router;
