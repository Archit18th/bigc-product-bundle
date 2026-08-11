-- Add surrogate auto-increment PK to `stores`, keep store_hash as a unique key.
ALTER TABLE `stores` DROP PRIMARY KEY;
ALTER TABLE `stores` ADD COLUMN `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;
CREATE UNIQUE INDEX `stores_store_hash_key` ON `stores`(`store_hash`);
