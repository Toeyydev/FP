-- CreateTable
CREATE TABLE "ProductMap" (
    "id" TEXT NOT NULL,
    "productKey" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductMap_productKey_key" ON "ProductMap"("productKey");
