-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `store_hash` VARCHAR(50) NOT NULL,
    `bc_user_id` INTEGER NULL,
    `email` VARCHAR(255) NULL,
    `access_token` TEXT NULL,
    `locale` VARCHAR(20) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `users_store_hash_idx`(`store_hash`),
    UNIQUE INDEX `users_store_hash_bc_user_id_key`(`store_hash`, `bc_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `store_settings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `store_hash` VARCHAR(50) NOT NULL,
    `default_discount_percent` INTEGER NOT NULL DEFAULT 0,
    `bundle_widget_enabled` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `store_settings_store_hash_key`(`store_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
