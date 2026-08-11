-- AlterTable
ALTER TABLE `users` ADD COLUMN `catalog_last_sync` DATETIME(3) NULL,
    ADD COLUMN `user_status` BOOLEAN NOT NULL DEFAULT false;
