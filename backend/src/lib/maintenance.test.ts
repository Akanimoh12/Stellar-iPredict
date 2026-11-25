import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMaintenanceState, type MaintenanceMode } from "./maintenance.js";
import type { Redis } from "ioredis";

describe("MaintenanceState", () => {
  let mockRedis: Redis;
  
  beforeEach(() => {
    mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
    } as any;
  });

  describe("getMode", () => {
    it("returns the mode from Redis when available", async () => {
      vi.mocked(mockRedis.get).mockResolvedValue("read_only");
      
      const state = createMaintenanceState(mockRedis, "off");
      const mode = await state.getMode();
      
      expect(mode).toBe("read_only");
      expect(mockRedis.get).toHaveBeenCalledWith("maintenance:mode");
    });

    it("returns default mode when Redis returns null", async () => {
      vi.mocked(mockRedis.get).mockResolvedValue(null);
      
      const state = createMaintenanceState(mockRedis, "read_only");
      const mode = await state.getMode();
      
      expect(mode).toBe("read_only");
    });

    it("returns default mode when Redis returns invalid value", async () => {
      vi.mocked(mockRedis.get).mockResolvedValue("invalid_mode");
      
      const state = createMaintenanceState(mockRedis, "off");
      const mode = await state.getMode();
      
      expect(mode).toBe("off");
    });

    it("falls back to default when Redis throws error", async () => {
      vi.mocked(mockRedis.get).mockRejectedValue(new Error("Connection failed"));
      
      const state = createMaintenanceState(mockRedis, "full");
      const mode = await state.getMode();
      
      expect(mode).toBe("full");
    });
  });

  describe("setMode", () => {
    it("sets the mode in Redis successfully", async () => {
      vi.mocked(mockRedis.set).mockResolvedValue("OK" as any);
      
      const state = createMaintenanceState(mockRedis, "off");
      await state.setMode("full");
      
      expect(mockRedis.set).toHaveBeenCalledWith("maintenance:mode", "full");
    });

    it("throws error for invalid mode", async () => {
      const state = createMaintenanceState(mockRedis, "off");
      
      await expect(state.setMode("invalid" as MaintenanceMode)).rejects.toThrow(
        "Invalid maintenance mode: invalid"
      );
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it("throws error when Redis fails", async () => {
      vi.mocked(mockRedis.set).mockRejectedValue(new Error("Write failed"));
      
      const state = createMaintenanceState(mockRedis, "off");
      
      await expect(state.setMode("full")).rejects.toThrow("Write failed");
    });

    it("accepts all valid modes", async () => {
      vi.mocked(mockRedis.set).mockResolvedValue("OK" as any);
      
      const state = createMaintenanceState(mockRedis, "off");
      
      await state.setMode("off");
      expect(mockRedis.set).toHaveBeenCalledWith("maintenance:mode", "off");
      
      await state.setMode("read_only");
      expect(mockRedis.set).toHaveBeenCalledWith("maintenance:mode", "read_only");
      
      await state.setMode("full");
      expect(mockRedis.set).toHaveBeenCalledWith("maintenance:mode", "full");
    });
  });
});
