-- CreateTable
CREATE TABLE `products` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `store_hash` VARCHAR(50) NOT NULL,
    `product_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `sku` VARCHAR(100) NULL,
    `price` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `inventory_level` INTEGER NOT NULL DEFAULT 0,
    `inventory_tracking` VARCHAR(20) NULL,
    `availability` VARCHAR(20) NULL,
    `thumbnail` TEXT NULL,
    `last_synced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `products_store_hash_idx`(`store_hash`),
    UNIQUE INDEX `products_store_hash_product_id_key`(`store_hash`, `product_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
