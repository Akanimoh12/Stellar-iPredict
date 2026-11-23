/**
 * Consistent Soft Delete and Audit Trail for Admin Actions (#1012)
 *
 * Admin and oracle writes record actor, timestamp, target entity, and previous/new values
 * for later review and dispute resolution.
 */

export interface AdminAuditEntry {
  action: "create" | "update" | "soft_delete" | "restore" | "oracle_override";
  actor: string;
  targetId: string | number;
  entityType: string;
  timestamp: Date;
  previousValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  isSoftDeleted?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SoftDeletableRecord {
  id: string | number;
  is_deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string | null;
  [key: string]: unknown;
}

export class AuditTrailManager {
  private inMemoryAuditLog: AdminAuditEntry[] = [];

  /**
   * Records an admin or oracle action audit record.
   */
  recordAdminAudit(entry: AdminAuditEntry, logger?: any): AdminAuditEntry {
    this.inMemoryAuditLog.push(entry);

    if (logger) {
      const logFn = logger.info || logger;
      logFn.call(
        logger,
        {
          auditAction: entry.action,
          actor: entry.actor,
          targetId: entry.targetId,
          entityType: entry.entityType,
          isSoftDeleted: entry.isSoftDeleted ?? false,
          timestamp: entry.timestamp.toISOString(),
        },
        `Admin audit: ${entry.action} on ${entry.entityType}#${entry.targetId} by ${entry.actor}`
      );
    }

    return entry;
  }

  /**
   * Applies soft delete semantics to an entity and records the audit trail.
   */
  softDeleteEntity<T extends SoftDeletableRecord>(
    entity: T,
    actor: string,
    entityType: string,
    reason?: string,
    logger?: any
  ): { updatedEntity: T; auditEntry: AdminAuditEntry } {
    const previousValue = { ...entity };
    const updatedEntity: T = {
      ...entity,
      is_deleted: true,
      deleted_at: new Date(),
      deleted_by: actor,
    };

    const auditEntry = this.recordAdminAudit(
      {
        action: "soft_delete",
        actor,
        targetId: entity.id,
        entityType,
        timestamp: new Date(),
        previousValue: previousValue as Record<string, unknown>,
        newValue: updatedEntity as Record<string, unknown>,
        isSoftDeleted: true,
        metadata: reason ? { reason } : undefined,
      },
      logger
    );

    return { updatedEntity, auditEntry };
  }

  getAuditEntriesForTarget(entityType: string, targetId: string | number): AdminAuditEntry[] {
    return this.inMemoryAuditLog.filter(
      (e) => e.entityType === entityType && String(e.targetId) === String(targetId)
    );
  }

  getAllAuditEntries(): AdminAuditEntry[] {
    return [...this.inMemoryAuditLog];
  }

  clear(): void {
    this.inMemoryAuditLog = [];
  }
}

export const auditTrailManager = new AuditTrailManager();
