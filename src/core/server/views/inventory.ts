import * as alt from 'alt-server';
import { InventoryType } from '../../shared/enums/inventoryTypes';
import { ItemType } from '../../shared/enums/itemType';
import { SYSTEM_EVENTS } from '../../shared/enums/system';
import { View_Events_Inventory } from '../../shared/enums/views';
import { DroppedItem, Item } from '../../shared/interfaces/Item';
import { isFlagEnabled } from '../../shared/utility/flags';
import { playerFuncs } from '../extensions/Player';
import { sha256Random } from '../utility/encryption';
import '../effects/heal';
import '../effects/vehicleRepair';
import { ATHENA_EVENTS_PLAYER } from '../enums/athena';
import { distance2d } from '../utility/vector';
import { stripCategory } from '../utility/category';
import { CategoryData } from '../interface/CategoryData';

/**
 * Let's talk about Inventory Logic! Woo!
 *
 * Inventories are complicated but here at Athena we want to simplify that process.
 * You cannot swap an item with another item.
 * Drag one out. Put one in. Simple.
 * Hard to come across bugs when you have to look for null slots.
 *
 * i - is for inventory
 * e - is for equipment
 * tab - is for a tab, belongs under inventory
 * g - is for ground
 * t - is for toolbar
 *
 * There are a ton of methods to help you along with managing inventory state.
 * They all fall under player.inventory().x
 *
 * The functions are rebound below so we can create this abstract solution for handling items.
 * Makes it nice and neat and keeps all the underlying code elsewhere.
 */

export class InventoryController {
    static groundItems: Array<DroppedItem> = [];
    static customItemRules: Array<Function> = [];

    /**
     * Item swap / equip / etc. rules that apply to an item swap, equip, etc.
     * These are ran for all items, equips, etc.
     * @static
     * @param {Function} someFunction
     * @memberof InventoryController
     */
    static addItemRuleCheck(someFunction: Function) {
        InventoryController.customItemRules.push(someFunction);
    }

    /**
     * Used when a player is moving one item from one space to another, equipping, etc.
     * @static
     * @param {alt.Player} player
     * @param {string} selectedSlot
     * @param {string} endSlot
     * @param {number} tab
     * @param {(string | null)} hash
     * @return {*}  {void}
     * @memberof InventoryController
     */
    static processItemMovement(
        player: alt.Player,
        selectedSlot: string,
        endSlot: string,
        tab: number,
        hash: string | null
    ): void {
        if (!player || !player.valid) {
            return;
        }

        if (selectedSlot === endSlot) {
            playerFuncs.sync.inventory(player);
            return;
        }

        // The data locations on `player.data` we are using.
        const endData = DataHelpers.find((dataInfo) => endSlot.includes(dataInfo.abbrv));
        const endSlotIndex = stripCategory(endSlot);
        const selectData = DataHelpers.find((dataInfo) => selectedSlot.includes(dataInfo.abbrv));

        if (selectData.name === InventoryType.TOOLBAR && endData.name !== InventoryType.TOOLBAR) {
            player.removeAllWeapons();
        }

        // Handle Drop Ground
        if (endData.name === InventoryType.GROUND) {
            InventoryController.handleDropGround(player, selectedSlot, tab);
            return;
        }

        // Pickup Item from Ground
        if (selectData.name === InventoryType.GROUND) {
            InventoryController.handlePickupGround(player, endData, endSlotIndex, hash, tab);
            return;
        }

        // Check if this is a swap or stack.
        if (endData.emptyCheck && !endData.emptyCheck(player, endSlotIndex, tab)) {
            playerFuncs.inventory.handleSwapOrStack(
                player,
                selectedSlot,
                endSlot,
                tab,
                InventoryController.customItemRules
            );
            return;
        }

        const selectSlotIndex = stripCategory(selectedSlot);
        const itemClone: Item = selectData.getItem(player, selectSlotIndex, tab);

        if (!itemClone) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (endData.name === InventoryType.TAB) {
            InventoryController.handleMoveTabs(
                player,
                itemClone,
                selectSlotIndex,
                tab,
                endSlotIndex,
                selectData.name,
                endData.name
            );
            return;
        }

        if (
            !playerFuncs.inventory.allItemRulesValid(
                player,
                itemClone,
                endData,
                endSlotIndex,
                InventoryController.customItemRules,
                tab
            )
        ) {
            playerFuncs.sync.inventory(player);
            return;
        }

        const isEquipmentItem = isFlagEnabled(itemClone.behavior, ItemType.IS_EQUIPMENT);
        if (isEquipmentItem && itemClone.data.sex !== player.data.appearance.sex) {
            playerFuncs.sync.inventory(player);
            return;
        }

        const didRemoveItem = selectData.removeItem(player, itemClone.slot, tab);
        if (!didRemoveItem) {
            playerFuncs.sync.inventory(player);
            return;
        }

        const didAddItem = endData.addItem(player, itemClone, endSlotIndex, tab);
        if (!didAddItem) {
            playerFuncs.sync.inventory(player);
            return;
        }

        playerFuncs.save.field(player, selectData.name, player.data[selectData.name]);
        playerFuncs.save.field(player, endData.name, player.data[endData.name]);
        playerFuncs.sync.inventory(player);
        playerFuncs.emit.sound2D(player, 'item_shuffle_1', Math.random() * 0.45 + 0.1);
    }

    /**
     * Move an item to a different tab.
     * We know the item exists when this function is called.
     * @static
     * @param {alt.Player} player
     * @param {Item} item
     * @memberof InventoryController
     */
    static handleMoveTabs(
        player: alt.Player,
        item: Item,
        selectSlotIndex: number,
        tab: number,
        tabToMoveTo: number,
        selectName: string,
        endName: string
    ) {
        // Find a similar item if it exists and stack it if it does exist.
        const freeSlot = playerFuncs.inventory.getFreeInventorySlot(player, tabToMoveTo);
        if (!freeSlot) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (!playerFuncs.inventory.inventoryRemove(player, selectSlotIndex, tab)) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (!playerFuncs.inventory.inventoryAdd(player, item, freeSlot.slot, freeSlot.tab)) {
            playerFuncs.sync.inventory(player);
            return;
        }

        playerFuncs.save.field(player, selectName, player.data[selectName]);
        playerFuncs.save.field(player, endName, player.data[endName]);
        playerFuncs.sync.inventory(player);
        playerFuncs.emit.sound2D(player, 'item_shuffle_1', Math.random() * 0.45 + 0.1);
    }

    /**
     * Propogates the item to appear on the ground.
     * @static
     * @param {string} selectedSlot
     * @param {number} tab
     * @memberof InventoryController
     */
    static handleDropGround(player: alt.Player, selectedSlot: string, tab: number) {
        const selectSlotIndex = stripCategory(selectedSlot);
        const selectData = DataHelpers.find((dataInfo) => selectedSlot.includes(dataInfo.abbrv));

        if (selectData.name === InventoryType.GROUND) {
            playerFuncs.sync.inventory(player);
            return;
        }

        const itemClone: Item = selectData.getItem(player, selectSlotIndex, tab);

        if (player.vehicle) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (!itemClone) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (!isFlagEnabled(itemClone.behavior, ItemType.CAN_DROP)) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (
            !playerFuncs.inventory.allItemRulesValid(
                player,
                itemClone,
                { name: 'ground' },
                null,
                InventoryController.customItemRules,
                tab
            )
        ) {
            playerFuncs.sync.inventory(player);
            return;
        }

        const didRemoveItem = selectData.removeItem(player, itemClone.slot, tab);
        if (!didRemoveItem) {
            playerFuncs.sync.inventory(player);
            return;
        }

        playerFuncs.save.field(player, selectData.name, player.data[selectData.name]);
        playerFuncs.sync.inventory(player);
        playerFuncs.emit.sound2D(player, 'item_drop_1', Math.random() * 0.45 + 0.1);

        // Destroys an item when it is dropped on the ground if the behavior calls for it.
        if (isFlagEnabled(itemClone.behavior, ItemType.DESTROY_ON_DROP)) {
            playerFuncs.emit.animation(player, 'random@mugging4', 'pickup_low', 33, 1200);
            playerFuncs.emit.message(player, `${itemClone.name} was destroyed on drop.`);
            return;
        }

        itemClone.hash = sha256Random(JSON.stringify(itemClone));
        InventoryController.groundItems.push({
            gridSpace: player.gridSpace,
            item: itemClone,
            position: playerFuncs.utility.getPositionFrontOf(player, 1),
            dimension: player.dimension
        });

        this.updateDroppedItemsAroundPlayer(player, true);
        playerFuncs.emit.animation(player, 'random@mugging4', 'pickup_low', 33, 1200);
        alt.emit(ATHENA_EVENTS_PLAYER.DROPPED_ITEM, player, itemClone);
    }

    static getDroppedItemsByGridSpace(gridSpace: number): Array<DroppedItem> {
        return InventoryController.groundItems.filter((item) => item.gridSpace === gridSpace);
    }

    static updateDroppedItemsAroundPlayer(player: alt.Player, updateOtherPlayers: boolean): void {
        let players = [player];

        if (updateOtherPlayers) {
            players = playerFuncs.utility.getClosestPlayers(player, 50);
        }

        const items = InventoryController.getDroppedItemsByGridSpace(player.gridSpace);
        for (let i = 0; i < players.length; i++) {
            const target = players[i];
            if (!target || !target.valid) {
                continue;
            }

            alt.emitClient(target, SYSTEM_EVENTS.POPULATE_ITEMS, items);
        }
    }

    static handlePickupGround(
        player: alt.Player,
        endData: CategoryData,
        endSlotIndex: number,
        hash: string | null,
        tab: number
    ) {
        if (player.vehicle) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (!endData.emptyCheck(player, endSlotIndex, tab)) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (!hash) {
            playerFuncs.sync.inventory(player);
            return;
        }

        const index = InventoryController.groundItems.findIndex((gItem) => gItem.item.hash === hash);
        if (index <= -1) {
            playerFuncs.sync.inventory(player);
            this.updateDroppedItemsAroundPlayer(player, false);
            return;
        }

        const droppedItem: DroppedItem = { ...InventoryController.groundItems[index] };
        if (distance2d(player.pos, droppedItem.position) >= 10) {
            playerFuncs.sync.inventory(player);
            this.updateDroppedItemsAroundPlayer(player, false);
            return;
        }

        if (
            !playerFuncs.inventory.allItemRulesValid(
                player,
                droppedItem.item,
                endData,
                endSlotIndex,
                InventoryController.customItemRules,
                tab
            )
        ) {
            playerFuncs.sync.inventory(player);
            this.updateDroppedItemsAroundPlayer(player, false);
            return;
        }

        const isEquipmentItem = isFlagEnabled(droppedItem.item.behavior, ItemType.IS_EQUIPMENT);
        const isGoingToEquipment = endData.name === InventoryType.EQUIPMENT;
        if (isEquipmentItem && isGoingToEquipment && droppedItem.item.data.sex !== player.data.appearance.sex) {
            playerFuncs.sync.inventory(player);
            this.updateDroppedItemsAroundPlayer(player, false);
            return;
        }

        const removedItems = InventoryController.groundItems.splice(index, 1);
        if (removedItems.length <= 0) {
            playerFuncs.sync.inventory(player);
            this.updateDroppedItemsAroundPlayer(player, false);
            return;
        }

        const didAddItem = endData.addItem(player, droppedItem.item, endSlotIndex, tab);
        if (!didAddItem) {
            playerFuncs.sync.inventory(player);
            this.updateDroppedItemsAroundPlayer(player, false);
            return;
        }

        playerFuncs.save.field(player, endData.name, player.data[endData.name]);
        playerFuncs.sync.inventory(player);
        playerFuncs.emit.sound2D(player, 'item_shuffle_1', Math.random() * 0.45 + 0.1);
        playerFuncs.emit.animation(player, 'random@mugging4', 'pickup_low', 33, 1200);
        this.updateDroppedItemsAroundPlayer(player, true);
    }

    /**
     * Called when a player right-clicks an item.
     * @static
     * @param {alt.Player} player
     * @param {string} selectedSlot
     * @param {number} tab
     * @return {*}
     * @memberof InventoryController
     */
    static processUse(player: alt.Player, selectedSlot: string, tab: number) {
        if (!selectedSlot || tab === undefined || tab === null) {
            playerFuncs.sync.inventory(player);
            return;
        }

        const slot = stripCategory(selectedSlot);
        if (isNaN(slot)) {
            playerFuncs.sync.inventory(player);
            return;
        }

        const item = playerFuncs.inventory.getInventoryItem(player, slot, tab);
        if (!item) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (!isFlagEnabled(item.behavior, ItemType.CONSUMABLE)) {
            playerFuncs.sync.inventory(player);
            return;
        }

        if (!isFlagEnabled(item.behavior, ItemType.SKIP_CONSUMABLE)) {
            item.quantity -= 1;

            if (item.quantity <= 0) {
                playerFuncs.inventory.inventoryRemove(player, slot, tab);
            } else {
                playerFuncs.inventory.replaceInventoryItem(player, item, tab);
            }

            playerFuncs.save.field(player, 'inventory', player.data.inventory);
            playerFuncs.sync.inventory(player);
        }

        if (item.data && item.data.event) {
            alt.emit(item.data.event, player, item, slot, tab);
            playerFuncs.emit.sound2D(player, 'item_use', Math.random() * 0.45 + 0.1);
        }
    }
}

const DataHelpers: Array<CategoryData> = [
    {
        abbrv: 'i-',
        name: 'inventory',
        emptyCheck: playerFuncs.inventory.isInventorySlotFree,
        getItem: playerFuncs.inventory.getInventoryItem,
        removeItem: playerFuncs.inventory.inventoryRemove,
        addItem: playerFuncs.inventory.inventoryAdd
    },
    {
        abbrv: 't-',
        name: 'toolbar',
        emptyCheck: playerFuncs.inventory.isToolbarSlotFree,
        getItem: playerFuncs.inventory.getToolbarItem,
        removeItem: playerFuncs.inventory.toolbarRemove,
        addItem: playerFuncs.inventory.toolbarAdd
    },
    {
        abbrv: 'e-',
        name: 'equipment',
        emptyCheck: playerFuncs.inventory.isEquipmentSlotFree,
        getItem: playerFuncs.inventory.getEquipmentItem,
        removeItem: playerFuncs.inventory.equipmentRemove,
        addItem: playerFuncs.inventory.equipmentAdd
    },
    { abbrv: 'g-', name: 'ground', emptyCheck: null, getItem: null, removeItem: null, addItem: null },
    {
        abbrv: 'tab-',
        name: 'tab',
        emptyCheck: null,
        getItem: null,
        removeItem: null,
        addItem: null
    }
];

alt.onClient(View_Events_Inventory.Use, InventoryController.processUse);
alt.onClient(View_Events_Inventory.Process, InventoryController.processItemMovement);
