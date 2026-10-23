import { Select } from "@webpack/common";

import { ListType } from "..";

export function ListPrioritySelector({ listType, setListPriority }: { listType: ListType; setListPriority: (v: ListType) => void; }) {
    return (
        <Select
            options={[
                { label: "Whitelist", value: ListType.Whitelist },
                { label: "Blacklist", value: ListType.BlackList }
            ]}
            placeholder={"Select a list type"}
            isSelected={v => v === listType}
            closeOnSelect={true}
            select={setListPriority}
            serialize={v => v}
        />
    );
}
