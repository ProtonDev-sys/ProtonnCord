# ToastNotifications

Shows message notifications in a corner of the screen for DMs, group DMs, and server channels.

## Configuration

| Setting | Behavior |
| --- | --- |
| Notification Position | Bottom left (default), bottom right, top left, or top right. |
| Notification Timeout | Display time in seconds, with a progress bar. Hover to keep a notification open; the timeout restarts when you move away. |
| Opacity | Notification opacity, from 10% to 100%. |
| Max Notifications | Maximum visible at once. New notifications replace the oldest when the limit is reached. |
| Disable In Streamer Mode | Suppress notifications while Discord's streamer mode is active. |
| Respect Do Not Disturb | Suppress notifications while your status is Do Not Disturb. |
| Direct Messages | Enable notifications for DMs. Muted DMs stay silent. |
| Group Messages | Enable notifications for group DMs. Muted group DMs stay silent. |
| Friend Server Notifications | Notify for friends' server messages, overriding server/channel mute and notification levels. |
| Ignored Users | Comma-separated user IDs to exclude, such as `123456789012345678,234567890123456789`. |
| Notify For | Comma-separated **server channel IDs** that override server/channel mute and notification levels. |

Your own messages, messages in the active channel, and ignored users never trigger a toast. Streamer mode and Do Not Disturb suppression still apply to friends and channels in **Notify For**.

Enable Discord's Developer Mode to copy user and channel IDs from their context menus.

## Theming

Override these CSS variables to style notifications:

| CSS Variable                                      | Description                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `--vc-toast-notifications-background-color`           | Background color of the notification card.                                 |
| `--vc-toast-notifications-text-color`                 | Default text color inside notifications.                                   |
| `--vc-toast-notifications-border-radius`              | Border radius of the notification card.                                    |
| `--vc-toast-notifications-width`                      | Width of the card. Defaults to `fit-content`.                              |
| `--vc-toast-notifications-min-width`                  | Minimum width to use regardless of content.                                |
| `--vc-toast-notifications-max-width`                  | Maximum width a single notification can grow to.                           |
| `--vc-toast-notifications-min-height`                 | Minimum height to use regardless of content.                               |
| `--vc-toast-notifications-max-height`                 | Maximum height a single notification can grow to.                          |
| `--vc-toast-notifications-padding`                    | Inner padding of the notification card.                                    |
| `--vc-toast-notifications-position-offset`            | Distance from the screen corner the stack is anchored at.                  |
| `--vc-toast-notifications-title-color`                | Color of titles (system notifications) and context headers (group/server). |
| `--vc-toast-notifications-title-font-size`            | Font size of titles and context headers.                                   |
| `--vc-toast-notifications-title-font-weight`          | Font weight of titles and context headers.                                 |
| `--vc-toast-notifications-title-line-height`          | Line height of titles and context headers.                                 |
| `--vc-toast-notifications-image-height`               | Height of the avatar/icon shown in system notifications.                   |
| `--vc-toast-notifications-image-width`                | Width of the avatar/icon shown in system notifications.                    |
| `--vc-toast-notifications-image-border-radius`        | Border radius of the avatar/icon in system notifications.                  |
| `--vc-toast-notifications-close-button-color`         | Color of the dismiss (X) button.                                           |
| `--vc-toast-notifications-close-button-hover-color`   | Color of the dismiss (X) button on hover.                                  |
| `--vc-toast-notifications-close-button-opacity`       | Opacity of the dismiss (X) button at rest.                                 |
| `--vc-toast-notifications-close-button-hover-opacity` | Opacity of the dismiss (X) button on hover.                                |
| `--vc-toast-notifications-progressbar-height`         | Height of the progress bar shown at the bottom of notifications.           |
| `--vc-toast-notifications-progressbar-color`          | Color of the progress bar.                                                 |
