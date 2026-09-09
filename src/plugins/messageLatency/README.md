# MessageLatency

Marks messages that meet the configured send-latency threshold.

- Only messages received after opening the channel are measured.
- System clock drift can cause false positives.
- Grouped messages show latency only for the first message.

## Demo

### Chat View

![chat-view](https://github.com/Vendicated/Vencord/assets/82430093/69430881-60b3-422f-aa3d-c62953837566)

### Clock running behind

![Latency indicator with a clock running behind](https://github.com/Vendicated/Vencord/assets/82430093/d9248b66-e761-4872-8829-e8bf4fea6ec8)

### Clock running ahead

![Latency indicator with a clock running ahead](https://github.com/Vendicated/Vencord/assets/82430093/0e9783cf-51d5-4559-ae10-42399e7d4099)

### Connection Delay

![Latency indicator after a connection delay](https://github.com/Vendicated/Vencord/assets/82430093/fd68873d-8630-42cc-a166-e9063d2718b2)

### Icons

![icons](https://github.com/Vendicated/Vencord/assets/82430093/17630bd9-44ee-4967-bcdf-3315eb6eca85)
