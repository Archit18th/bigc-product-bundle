-- Add storefront URL to bundles mirror
ALTER TABLE `bundles` ADD COLUMN `url` VARCHAR(500) NULL;
