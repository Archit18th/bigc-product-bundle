-- CreateTable
CREATE TABLE `bundles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `store_hash` VARCHAR(50) NOT NULL,
    `bundle_product_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `price` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `sale_price` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `discount_percent` INTEGER NOT NULL DEFAULT 0,
    `inventory_level` INTEGER NOT NULL DEFAULT 0,
    `available` BOOLEAN NOT NULL DEFAULT true,
    `components` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `inventory_synced_at` DATETIME(3) NOT NULL,

    INDEX `bundles_store_hash_idx`(`store_hash`),
    UNIQUE INDEX `bundles_store_hash_bundle_product_id_key`(`store_hash`, `bundle_product_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
