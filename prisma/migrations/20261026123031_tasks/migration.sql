-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kidId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reward" INTEGER NOT NULL,
    "dueDate" DATETIME,
    "recurrence" TEXT NOT NULL DEFAULT 'NONE',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "rewardGoalId" TEXT,
    "submittedAt" DATETIME,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_kidId_fkey" FOREIGN KEY ("kidId") REFERENCES "Kid" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Task_kidId_status_idx" ON "Task"("kidId", "status");
