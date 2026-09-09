# ThemeAttributes

Adds attributes and CSS variables for styling tabs, messages, and avatars.

## Available Attributes

### All Tab Bars (User Settings, Server Settings, etc)

`data-tab-id` contains the tab ID.

![image](https://github.com/Vendicated/Vencord/assets/45497981/1263b782-f673-4f09-820c-4cc366d062ad)

### Chat Messages

- `data-author-id` contains the id of the author
- `data-author-username` contains the username of the author
- `data-is-self` is a boolean indicating whether this is the current user's message

![image](https://github.com/Vendicated/Vencord/assets/45497981/34bd5053-3381-402f-82b2-9c812cc7e122)

## CSS Variables

### Avatars

`--avatar-url-<resolution>` contains the user's avatar URL at that size. Available resolutions: `128`, `256`, `512`, `1024`, `2048`, and `4096`.

![image](https://github.com/Vendicated/Vencord/assets/26598490/192ddac0-c827-472f-9933-fa99ff36f723)
