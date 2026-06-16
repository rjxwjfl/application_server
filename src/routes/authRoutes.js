const express = require("express");
const authController = require("../api/auth/authController");
const router = express.Router();

router.post("/register", authController.register);

// /me routes (design spec)
router.get("/me", authController.getMe);
router.patch("/me", authController.updateMe);
router.delete("/me", authController.deleteMe);
router.patch("/me/settings", authController.updateSettings);
router.post("/me/devices", authController.registerDevice);
router.delete("/me/devices/:deviceUuid", authController.removeDevice);

// Extra routes (not in design spec, kept for app functionality)
router.put("/me/image", authController.updateProfileImage);
router.post("/logout", authController.logout);
router.post("/reactivate", authController.reactivate);
router.get("/me/devices", authController.getDevices);

module.exports = router;
