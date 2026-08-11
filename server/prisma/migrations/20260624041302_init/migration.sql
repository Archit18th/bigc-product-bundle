-- CreateTable
CREATE TABLE `stores` (
    `store_hash` VARCHAR(50) NOT NULL,
    `access_token` TEXT NOT NULL,
    `user_json` JSON NOT NULL,
    `system_category_id` INTEGER NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`store_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
