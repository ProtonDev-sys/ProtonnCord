# KeyboardNavigation actions

Use `registerAction` from [commands.tsx](commands.tsx) to add an action to KeyboardNavigation's command palette. Register it when your plugin starts and call the returned cleanup function when it stops.

Each action needs a unique `id` and a visible `label`. Its optional `callback` runs when selected.

## Multiple choice

[openMultipleChoice](components/MultipleChoice.tsx) returns the selected `ButtonAction`, or `null` if the modal is dismissed.

```ts
const removeChoiceAction = registerAction({
    id: "myPlugin.multipleChoice",
    label: "Multiple Choice",
    callback: async () => {
        const choice = await openMultipleChoice([
            { id: "first", label: "First choice" },
            { id: "second", label: "Second choice" },
        ]);
        if (choice === null) return;
        console.log(choice.id, choice.label);
    },
});
```

## Text input

[openSimpleTextInput](components/TextInput.tsx) returns the entered string, or `null` if dismissed. An empty string is a valid result.

```ts
const removeTextAction = registerAction({
    id: "myPlugin.textInput",
    label: "Text Input",
    callback: async () => {
        const text = await openSimpleTextInput();
        if (text === null) return;
        console.log(text);
    },
});
```

Call `removeChoiceAction()` and `removeTextAction()` from your plugin's stop hook to unregister these examples.
