CREATE TABLE `boards` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`board_id` text NOT NULL,
	`column` text NOT NULL,
	`created_at` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`id` text PRIMARY KEY,
	`position` integer DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	CONSTRAINT `fk_cards_board_id_boards_id_fk` FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE CASCADE,
	CONSTRAINT "cards_column_check" CHECK("column" in ('backlog', 'todo', 'doing', 'done'))
);
