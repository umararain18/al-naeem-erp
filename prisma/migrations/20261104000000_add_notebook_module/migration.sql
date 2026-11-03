-- CreateEnum
CREATE TYPE "public"."NotebookVehicleStatus" AS ENUM ('AVAILABLE', 'LOADING', 'DISPATCHED');

-- CreateTable
CREATE TABLE "public"."Notebook" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notebook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotebookVehicle" (
    "id" TEXT NOT NULL,
    "notebookId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "vehicleNumber" TEXT NOT NULL,
    "status" "public"."NotebookVehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "note" TEXT,

    CONSTRAINT "NotebookVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notebook_date_key" ON "public"."Notebook"("date");

-- CreateIndex
CREATE INDEX "Notebook_date_idx" ON "public"."Notebook"("date");

-- CreateIndex
CREATE INDEX "NotebookVehicle_notebookId_idx" ON "public"."NotebookVehicle"("notebookId");

-- AddForeignKey
ALTER TABLE "public"."Notebook" ADD CONSTRAINT "Notebook_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotebookVehicle" ADD CONSTRAINT "NotebookVehicle_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "public"."Notebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
