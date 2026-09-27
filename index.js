import "dotenv/config";
import express from "express";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

import { registerCommands } from "./register-commands.js";
import { BANK_NAME, PAR_T_FARES, PAR_T_DISCOUNTS } from "./constants.js";
import { db, unwrap, testSupabaseConnection, charactersFor, characterById, activeCharacter, setActiveCharacter, accountFor, requireChecking, ensureOwnedCharacter } from "./db.js";
import { buttonRow, isModerator, nova, randomId, selectRow, toVoro } from "./utils.js";
import { renderEquityTransaction, renderPartTicket } from "./receipts.js";

if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
  throw new Error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID.");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

process.on("unhandledRejection", error => {
  console.error("[Unhandled rejection]", error);
});

process.on("uncaughtException", error => {
  console.error("[Uncaught exception]", error);
});


const app = express();
app.get("/", (_req, res) => res.send("John is online."));
app.get("/health", (_req, res) => res.json({ ok: true, bot: "John", bank: BANK_NAME }));
app.listen(Number(process.env.PORT || 3000), () => console.log("John health server ready."));

if (process.env.REGISTER_COMMANDS !== "false") await registerCommands();


const CLUB_PRESETS = {
  oak_society:{label:"Oak Society",description:"Boy Scouts-style youth society",actions:[["Attend Society Meeting","meeting"],["Earn a Badge","badge"],["Go on an Outing","outing"],["Do Community Service","service"],["Practice Outdoor Skills","skills"]]},
  magnolia_society:{label:"Magnolia Society",description:"Girls' youth society",actions:[["Attend Society Meeting","meeting"],["Earn a Badge","badge"],["Go on an Outing","outing"],["Do Community Service","service"],["Work on a Group Project","project"]]},
  book_club:{label:"Book Club",description:"Reading and discussion group",actions:[["Attend Book Club Meeting","meeting"],["Discuss the Book","discussion"],["Recommend a Book","recommend"],["Bring Snacks","snacks"],["Host the Meeting","host"]]},
  biking_club:{label:"Biking Club",description:"Cycling and group ride club",actions:[["Go on a Group Ride","ride"],["Try a New Route","route"],["Bike Maintenance Day","maintenance"],["Attend Club Meetup","meeting"],["Invite Someone on a Ride","invite"]]},
  fitness_club:{label:"Fitness Club",description:"Workout and wellness club",actions:[["Join a Group Workout","workout"],["Take a Fitness Class","class"],["Attend Club Meetup","meeting"],["Do a Challenge","challenge"],["Support a Club Member","support"]]},
  art_club:{label:"Art Club",description:"Creative arts group",actions:[["Attend Art Session","session"],["Work on a Group Piece","group_piece"],["Share Your Work","share"],["Visit an Exhibit","exhibit"],["Try a New Medium","medium"]]},
  cooking_club:{label:"Cooking Club",description:"Cooking and food group",actions:[["Cook Together","cook"],["Try a New Recipe","recipe"],["Host a Tasting","tasting"],["Attend Club Dinner","dinner"],["Teach a Recipe","teach"]]},
  gaming_club:{label:"Gaming Club",description:"Video, tabletop, and social gaming group",actions:[["Join Game Night","game_night"],["Play a Tournament","tournament"],["Try a New Game","new_game"],["Host a Session","host"],["Team Up With Members","team"]]},
  mommy_and_me:{label:"Mommy & Me Group",description:"Parent-and-child social group",actions:[["Attend a Playdate","playdate"],["Join Parent Meetup","meeting"],["Do a Family Activity","family_activity"],["Support Another Parent","support"],["Attend Story Time","story_time"]]},
  father_group:{label:"Father Group",description:"Fathers' social and support group",actions:[["Attend Dad Meetup","meeting"],["Plan a Family Activity","family_activity"],["Join a Group Outing","outing"],["Support Another Father","support"],["Host a Dad Day","host"]]},
  brunch_bunch:{label:"Brunch Bunch Club",description:"Social brunch and outing club",actions:[["Go to Brunch","brunch"],["Try a New Spot","new_spot"],["Host Brunch","host"],["Celebrate a Member","celebrate"],["Plan the Next Outing","plan"]]},
  dance_group:{label:"Dance Group",description:"Dance practice and performance group",actions:[["Attend Dance Practice","practice"],["Learn Choreography","choreo"],["Freestyle Session","freestyle"],["Perform Together","perform"],["Help a Group Member","support"]]},
  volunteer_group:{label:"Volunteer Group",description:"Community service and outreach group",actions:[["Volunteer at an Event","event"],["Organize Donations","donations"],["Community Cleanup","cleanup"],["Help a Local Cause","cause"],["Plan a Service Day","plan"]]},
  responsible_growth_round_table:{label:"Responsible Growth Round Table",description:"Political and public-policy discussion group",actions:[["Attend Policy Round Table","meeting"],["Discuss a Proposal","proposal"],["Review Community Data","review"],["Draft a Recommendation","draft"],["Host a Civic Forum","forum"]]},
  animal_welfare_collaborative:{label:"Animal Welfare Collaborative",description:"Animal welfare advocacy and service group",actions:[["Volunteer With Animals","volunteer"],["Organize a Supply Drive","drive"],["Support an Adoption Event","adoption"],["Attend Welfare Meeting","meeting"],["Raise Awareness","awareness"]]},
  youth_green_cabinet:{label:"Youth Green Cabinet",description:"Youth environmental service group",actions:[["Plant Trees","trees"],["Join a Cleanup Day","cleanup"],["Work on a Garden Project","garden"],["Run a Recycling Drive","recycling"],["Attend Green Cabinet Meeting","meeting"]]},
  homeowners_association:{label:"Homeowners Association",description:"Neighborhood homeowners association",actions:[["Attend HOA Meeting","meeting"],["Vote on a Proposal","vote"],["File a Neighborhood Issue","issue"],["Organize a Cleanup","cleanup"],["Review a Community Proposal","review"]]},
  custom:{label:"Other / Custom Club",description:"Custom group using general club activities",actions:[["Attend Group Meeting","meeting"],["Join a Group Activity","activity"],["Help Plan an Event","plan"],["Support Another Member","support"],["Host a Meetup","host"]]}
};


function modal(id, title, fields) {
  const m = new ModalBuilder().setCustomId(id).setTitle(title.slice(0,45));
  m.addComponents(...fields.map(f => new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(f.label.slice(0,45))
      .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(f.required ?? true)
      .setPlaceholder((f.placeholder || "").slice(0,100))
      .setValue((f.value || "").slice(0,4000))
  )));
  return m;
}

function userSelectRow(customId, placeholder = "Choose a Discord user") {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

async function respond(i, payload) {
  if (i.deferred) return i.editReply(payload);
  if (i.replied) return i.followUp(payload);
  return i.reply(payload);
}


const JOHN_PRIVATE_NOTIFICATION_TYPES = new Set([
  "payday",
  "housing_due",
  "housing_paid",
  "subscription_renewal",
  "subscription_payment_failed",
  "failed_money",
  "vylt_send",
  "vylt_request",
  "job_approval",
  "contract_approval",

  // Setup/payment flows remain private to the person using John.
  "shopping_setup",
  "shopping_checkout",
  "ride_setup",
  "ride_booking"
]);

const JOHN_PUBLIC_WORLD_EVENT_TYPES = new Set([
  "item_gift",
  "shop_gift",
  "ride_arrived",
  "driver_arrived",
  "delivery_arrived",
  "world_activity"
]);

function johnNotificationPrivacy(type){
  if (JOHN_PRIVATE_NOTIFICATION_TYPES.has(type)) return "private";
  return "public";
}

async function sendJohnPrivateNotification(discordUserId,payload){
  try{
    const user=await client.users.fetch(discordUserId);
    await user.send(payload);
    return true;
  }catch(err){
    console.warn(`[PRIVATE NOTIFICATION FAILED] ${discordUserId}:`,err.message);
    return false;
  }
}

async function sendJohnPublicNotification(i,payload){
  try{
    if(!i?.channel?.send){
      console.warn("[PUBLIC NOTIFICATION SKIPPED] No usable interaction channel.");
      return false;
    }
    await i.channel.send(payload);
    return true;
  }catch(err){
    console.warn("[PUBLIC NOTIFICATION FAILED]",err.message);
    return false;
  }
}

async function sendJohnNotification({i,type,discordUserId,payload}){
  if(johnNotificationPrivacy(type)==="private"){
    if(!discordUserId) throw new Error(`Private notification ${type} is missing a Discord user ID.`);
    return sendJohnPrivateNotification(discordUserId,payload);
  }
  return sendJohnPublicNotification(i,payload);
}




const handledInteractionIds = new Set();

function claimInteraction(i) {
  if (!i?.id) return true;
  if (handledInteractionIds.has(i.id)) {
    console.warn(`[DUPLICATE INTERACTION IGNORED] ${i.id}`);
    return false;
  }
  handledInteractionIds.add(i.id);
  const timer = setTimeout(()=>handledInteractionIds.delete(i.id),60_000);
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

const shopActionTokens = new Map();

const shopCarts = new Map();

const vantageCarts = new Map();

const VANTAGE_CATEGORY_LABELS = {
  electronics:"Electronics", home:"Home", clothing:"Clothing", beauty:"Beauty",
  toys_games:"Toys & Games", office_school:"Office & School", kitchen:"Kitchen",
  furniture:"Furniture", baby_kids:"Baby & Kids", sports_fitness:"Sports & Fitness",
  auto:"Auto & Car Accessories", pet:"Pet Supplies", jewelry:"Jewelry & Accessories",
  misc:"Miscellaneous"
};

const VANTAGE_PRICES = {
  small:1999,
  medium:4999,
  large:9999
};

function vantageCartKey(userId,characterId){
  return `${userId}:${characterId}`;
}

function getVantageCart(userId,characterId){
  const key=vantageCartKey(userId,characterId);
  if(!vantageCarts.has(key)) vantageCarts.set(key,{items:[],createdAt:Date.now()});
  return vantageCarts.get(key);
}

function vantageCartTotal(cart){
  return (cart?.items||[]).reduce((sum,x)=>sum+(Number(x.price_voro||0)*Number(x.quantity||1)),0);
}

function vantageCartLines(cart){
  return (cart?.items||[]).map((x,n)=>
    `${n+1}. **${x.name}** × ${x.quantity} — ${nova(Number(x.price_voro||0)*Number(x.quantity||1))}`
  ).join("\n");
}


async function loadVantageCart(characterId,userId){
  await ensureOwnedCharacter(characterId,userId);
  const rows=unwrap(await db.from("vantage_cart_items")
    .select("id,character_id,category,size,item_name,price_voro,quantity,created_at")
    .eq("character_id",characterId)
    .order("created_at",{ascending:true}),"load Vantage cart") || [];
  return {items:rows.map(r=>({
    id:r.id,category:r.category,size:r.size,name:r.item_name,
    price_voro:Number(r.price_voro||0),quantity:Number(r.quantity||1)
  }))};
}

async function addVantageCartItem(characterId,userId,action){
  await ensureOwnedCharacter(characterId,userId);
  const existing=unwrap(await db.from("vantage_cart_items")
    .select("id,quantity")
    .eq("character_id",characterId)
    .eq("category",action.category)
    .eq("size",action.size)
    .limit(1),"find Vantage cart item")?.[0];

  if(existing){
    unwrap(await db.from("vantage_cart_items")
      .update({quantity:Number(existing.quantity||1)+1,updated_at:new Date().toISOString()})
      .eq("id",existing.id),"increase Vantage cart item");
  }else{
    unwrap(await db.from("vantage_cart_items").insert({
      character_id:characterId,
      category:action.category,
      size:action.size,
      item_name:action.itemName,
      price_voro:Number(action.price_voro),
      quantity:1
    }),"add Vantage cart item");
  }
  return loadVantageCart(characterId,userId);
}

async function clearVantageCart(characterId,userId){
  await ensureOwnedCharacter(characterId,userId);
  unwrap(await db.from("vantage_cart_items")
    .delete().eq("character_id",characterId),"clear Vantage cart");
}




function makeShopCart(payload) {
  const token = Math.random().toString(36).slice(2,10);
  shopCarts.set(token,{...payload,createdAt:Date.now()});
  for (const [key,val] of shopCarts) {
    if (Date.now() - val.createdAt > 30 * 60 * 1000) shopCarts.delete(key);
  }
  return token;
}

function getShopCart(token) {
  const cart = shopCarts.get(token);
  if (!cart) throw new Error("That shopping cart expired. Open /shop and try again.");
  return cart;
}



function makeShopToken(payload) {
  const token = Math.random().toString(36).slice(2,10);
  shopActionTokens.set(token,{...payload,createdAt:Date.now()});
  // Light cleanup so stale button tokens do not accumulate forever.
  for (const [key,val] of shopActionTokens) {
    if (Date.now() - val.createdAt > 30 * 60 * 1000) shopActionTokens.delete(key);
  }
  return token;
}

function getShopToken(token) {
  const payload = shopActionTokens.get(token);
  if (!payload) throw new Error("That shop selection expired. Re-open the item and try again.");
  return payload;
}

async function currentCharacter(i) {
  let c = await activeCharacter(i.user.id, i.guildId);
  if (c) return c;

  // Self-heal the guild active-character pointer when possible.
  // Character records themselves are global; only the active selection is guild-specific.
  const owned = await charactersFor(i.user.id);

  if (owned.length === 1) {
    c = owned[0];
    await setActiveCharacter(i.user.id, i.guildId, c.id);
    console.log(`[Character] Restored active character ${c.name} for ${i.user.id} in guild ${i.guildId}`);
    return c;
  }

  if (!owned.length) {
    throw new Error("You do not have a John character yet. Use `/character` to create one.");
  }

  throw new Error("Your characters are still saved, but this server needs an active one selected. Use `/character` → Switch Character.");
}

async function characterOptions(userId) {
  const rows = await charactersFor(userId);
  return rows.map(c => ({ label: c.name.slice(0,100), value: c.id }));
}




async function runHousingMaintenance() {
  try {
    const generated = unwrap(
      await db.rpc("ensure_monthly_property_bills"),
      "housing monthly bill generation"
    );
    if (generated) console.log("[Housing] Monthly bills ensured:", generated);

    const result = unwrap(
      await db.rpc("process_property_overdue_ladder"),
      "housing overdue maintenance"
    );
    if (result) console.log("[Housing] Billing/overdue maintenance processed:", result);
  } catch (e) {
    console.error("[Housing] Maintenance error:", e.message);
  }
}

async function activeCheckingFor(characterId) {
  return unwrap(await db.from("bank_accounts")
    .select("id,balance_voro,status")
    .eq("character_id",characterId)
    .eq("account_type","checking")
    .eq("status","active")
    .limit(1),"active checking")?.[0] || null;
}

async function businessAccountFor(businessId) {
  return unwrap(await db.from("bank_accounts")
    .select("id,balance_voro,status")
    .eq("business_id",businessId)
    .eq("account_type","business")
    .eq("status","active")
    .limit(1),"business account")?.[0] || null;
}

async function ensureBusinessOwnerOrModerator(i,businessId){
  const business=unwrap(await db.from("businesses")
    .select("id,name,business_type,owner_character_id,status")
    .eq("id",businessId)
    .limit(1),"business owner permission")?.[0];

  if(!business) throw new Error("Business not found.");
  if(isModerator(i)) return business;

  const c=await currentCharacter(i);
  if(!business.owner_character_id || business.owner_character_id!==c.id){
    throw new Error("Only the business owner can manage this business.");
  }
  return business;
}

async function businessManagementAccess(i,businessId,{ownerOnly=false}={}) {
  const business=unwrap(await db.from("businesses")
    .select("id,name,business_type,owner_character_id,status")
    .eq("id",businessId)
    .limit(1),"business management access")?.[0];

  if(!business) throw new Error("Business not found.");
  if(isModerator(i)) return {business,role:"moderator",character:null};

  const c=await currentCharacter(i);
  if(business.owner_character_id===c.id) {
    return {business,role:"owner",character:c};
  }

  if(ownerOnly) throw new Error("Only the business owner can do that.");

  const manager=unwrap(await db.from("jobs")
    .select("id,employment_role,status")
    .eq("business_id",businessId)
    .eq("character_id",c.id)
    .eq("status","active")
    .eq("employment_role","manager")
    .limit(1),"business manager access")?.[0];

  if(manager) return {business,role:"manager",character:c};
  throw new Error("You do not manage this business.");
}

async function accessibleBusinessIds(i) {
  if(isModerator(i)) return null;
  const c=await currentCharacter(i);

  const owned=unwrap(await db.from("businesses")
    .select("id")
    .eq("owner_character_id",c.id)
    .limit(25),"owned businesses") || [];

  const managed=unwrap(await db.from("jobs")
    .select("business_id")
    .eq("character_id",c.id)
    .eq("status","active")
    .eq("employment_role","manager")
    .not("business_id","is",null)
    .limit(25),"managed businesses") || [];

  return [...new Set([
    ...owned.map(x=>x.id),
    ...managed.map(x=>x.business_id).filter(Boolean)
  ])];
}


async function transferableAccountsFor(characterId) {
  const personal = unwrap(await db.from("bank_accounts")
    .select("id,account_type,balance_voro,status")
    .eq("character_id",characterId)
    .in("account_type",["checking","savings"])
    .eq("status","active"),"transfer personal accounts") || [];

  const memberships = unwrap(await db.from("joint_account_members")
    .select("role,status,joint_accounts(id,name,account_type,status,bank_account_id,bank_accounts(id,account_type,balance_voro,status))")
    .eq("character_id",characterId)
    .eq("status","active"),"transfer joint accounts") || [];

  const rows = personal.map(a => ({
    id:a.id,
    label:a.account_type === "checking" ? "Checking" : "Savings",
    kind:"personal",
    balance_voro:a.balance_voro
  }));

  for (const m of memberships) {
    const j = m.joint_accounts;
    const a = j?.bank_accounts;
    if (!j || !a || j.status !== "active" || a.status !== "active") continue;
    rows.push({
      id:a.id,
      label:`${j.name} — Joint ${j.account_type === "checking" ? "Checking" : "Savings"}`,
      kind:"joint",
      balance_voro:a.balance_voro
    });
  }

  return rows;
}

async function bankHome(i, c) {
  const checking = await accountFor(c.id, "checking");
  const savings = await accountFor(c.id, "savings");
  const cash = unwrap(await db.from("character_cash").select("balance_voro").eq("character_id", c.id).limit(1), "cash")?.[0]?.balance_voro ?? 0;

  const embed = new EmbedBuilder()
    .setTitle(`🏦 ${BANK_NAME}`)
    .setDescription(`**${c.name}**`)
    .setThumbnail("attachment://equity_financial_logo.jpeg")
    .addFields(
      { name: "Checking", value: checking ? nova(checking.balance_voro) : "Not opened", inline: true },
      { name: "Savings", value: savings ? nova(savings.balance_voro) : "Not opened", inline: true },
      { name: "Unbanked Nova", value: nova(cash), inline: true }
    );

  const components = [];
  const actions = [];
  if (!checking) actions.push({ id:`bank_open_checking:${c.id}`, label:"Open Checking", style:ButtonStyle.Success });
  if (checking && !savings) actions.push({ id:`bank_open_savings:${c.id}`, label:"Open Savings", style:ButtonStyle.Success });
  const transferable = await transferableAccountsFor(c.id);
  if (transferable.length >= 2) actions.push({ id:`bank_transfer:${c.id}`, label:"Transfer" });
  actions.push({ id:`bank_transactions:${c.id}`, label:"Transactions" });
  actions.push({ id:`bank_joint:${c.id}`, label:"Joint Accounts" });
  actions.push({ id:`bank_cashout:${c.id}`, label:"Cash Out" });
  actions.push({ id:`bank_deposit:${c.id}`, label:"Deposit Cash" });
  actions.push({ id:`bank_manage_accounts:${c.id}`, label:"Manage Accounts" });
  // Discord allows a maximum of 5 buttons in one Action Row.
  // Split larger bank menus across multiple rows.
  for (let n = 0; n < actions.length; n += 5) {
    components.push(buttonRow(actions.slice(n, n + 5)));
  }

  return respond(i, {
    embeds: [embed],
    files: [new AttachmentBuilder("equity_financial_logo.jpeg", { name:"equity_financial_logo.jpeg" })],
    components
  });
}

async function showCharacters(i) {
  const chars = await charactersFor(i.user.id);
  const active = await activeCharacter(i.user.id, i.guildId);
  return respond(i, {
    embeds:[new EmbedBuilder()
      .setTitle("👤 Character System")
      .setDescription(`Global characters: **${chars.length}**\nActive here: **${active?.name || "None"}**`)],
    components:[buttonRow([
      {id:"character_create",label:"Create",style:ButtonStyle.Success},
      {id:"character_switch",label:"Switch"},
      {id:"character_view",label:"View"},
      {id:"character_edit",label:"Edit"},
      {id:"character_remove",label:"Remove",style:ButtonStyle.Danger}
    ])]
  });
}

async function appsHome(i, c) {
  return respond(i, {
    content:`📱 **${c.name}'s Apps**`,
    components:[selectRow("apps_pick","Choose an app",[
      {label:"Vantage",description:"Marketplace",value:"vantage"},
      {label:"VYLT",description:"Send and request Nova",value:"vylt"},
      {label:"VYBE",description:"Ride share",value:"vybe"},
      {label:"NABIT",description:"Food and shop delivery",value:"nabit"},
      {label:"PAR-T",description:"Bus, light rail, and train tickets",value:"part"}
    ])]
  });
}

async function partHome(i, c) {
  return respond(i, {
    content:`🚌 **PAR-T GO — ${c.name}**\nPlan. Pay. Ride.`,
    components:[selectRow(`part_transit:${c.id}`,"Choose transit type",[
      {label:"Bus",value:"bus"},
      {label:"Light Rail",value:"light_rail"},
      {label:"Train",value:"train"}
    ])]
  });
}


async function adminHome(i) {
  if (!i.memberPermissions?.has("Administrator")) {
    throw new Error("Administrator permission required.");
  }

  const [characters, businesses, jobs, properties, vehicles, subscriptions, accounts, audit] = await Promise.all([
    db.from("characters").select("id", { count: "exact", head: true }),
    db.from("businesses").select("id", { count: "exact", head: true }),
    db.from("jobs").select("id", { count: "exact", head: true }),
    db.from("properties").select("id", { count: "exact", head: true }),
    db.from("vehicles").select("id", { count: "exact", head: true }),
    db.from("subscriptions").select("id", { count: "exact", head: true }),
    db.from("bank_accounts").select("account_type,balance_voro").eq("status","active"),
    db.from("admin_audit_logs").select("*").order("created_at",{ascending:false}).limit(5)
  ]);

  for (const [label, result] of Object.entries({characters,businesses,jobs,properties,vehicles,subscriptions,accounts,audit})) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  const rows = accounts.data || [];
  const personal = rows.filter(a => a.account_type !== "business").reduce((n,a)=>n+Number(a.balance_voro||0),0);
  const businessNova = rows.filter(a => a.account_type === "business").reduce((n,a)=>n+Number(a.balance_voro||0),0);

  return respond(i, {
    embeds:[new EmbedBuilder()
      .setTitle("🛠️ John Admin Dashboard")
      .setDescription("Global economy overview and administration.")
      .addFields(
        {name:"Characters", value:String(characters.count || 0), inline:true},
        {name:"Businesses", value:String(businesses.count || 0), inline:true},
        {name:"Jobs", value:String(jobs.count || 0), inline:true},
        {name:"Properties", value:String(properties.count || 0), inline:true},
        {name:"Vehicles", value:String(vehicles.count || 0), inline:true},
        {name:"Subscriptions", value:String(subscriptions.count || 0), inline:true},
        {name:"Personal Nova", value:nova(personal), inline:true},
        {name:"Business Nova", value:nova(businessNova), inline:true}
      )],
    components:[
      selectRow("admin_menu","Choose an admin tool",[
        {label:"Economy Overview",value:"overview"},
        {label:"Balance Adjustment",value:"balance"},
        {label:"Assign Job",value:"assign_job"},
        {label:"Job Applications",value:"job_applications"},
        {label:"End Job",value:"end_job"},
        {label:"Issue Commission / Custom Pay",value:"issue_manual_pay"},
        {label:"Audit Logs",value:"logs"},
        {label:"Economy Settings",value:"settings"},
        {label:"Pending Contracts",value:"contracts"},
        {label:"Business Overview",value:"businesses"}
      ])
    ]
  });
}


function formatBusinessMenu(items = []) {
  if (!items.length) return "No items have been added yet.";

  const groups = new Map();
  for (const item of items) {
    const category = (item.category || "Menu").trim() || "Menu";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  }

  const sections = [];
  for (const [category, rows] of groups.entries()) {
    sections.push(`**${category.toUpperCase()}**`);
    for (const item of rows) {
      const unavailable = item.is_active === false ? "  •  *Unavailable*" : "";
      const description = item.description ? `\n${item.description}` : "";
      sections.push(`**${item.item_name}**\n${nova(item.price_voro)}${unavailable}${description}`);
    }
  }

  return sections.join("\n\n").slice(0,3900);
}

async function shopPageView(i, c, businessId, requestedPage = 0) {
  const PAGE_SIZE = 25;

  const business = unwrap(await db.from("businesses")
    .select("id,name,business_type,status,logo_url")
    .eq("id",businessId)
    .in("business_type",["shop","restaurant"])
    .eq("status","open")
    .limit(1),"shop business detail")?.[0];

  if (!business) throw new Error("That business is not currently available.");

  const countResult = await db.from("business_items")
    .select("id",{count:"exact",head:true})
    .eq("business_id",business.id)
    .eq("is_active",true);

  if (countResult.error) throw countResult.error;

  const totalItems = Number(countResult.count || 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, totalPages - 1));
  const start = page * PAGE_SIZE;
  const end = start + PAGE_SIZE - 1;

  const items = unwrap(await db.from("business_items")
    .select("id,item_name,price_voro,category,description,is_active")
    .eq("business_id",business.id)
    .eq("is_active",true)
    .order("category",{ascending:true})
    .order("item_name",{ascending:true})
    .range(start,end),"shop business items page") || [];

  const preview = formatBusinessMenu(items);
  const menuEmbed = new EmbedBuilder()
    .setTitle(`${business.business_type === "restaurant" ? "🍽️" : "🛍️"} ${business.name}`)
    .setDescription(
      `${business.business_type === "restaurant" ? "*MENU*" : "*CATALOG*"}\n\n` +
      `${preview}\n\n────────────\n` +
      `*Viewing as ${c.name} • Page ${page + 1} of ${totalPages} • ${totalItems} item${totalItems === 1 ? "" : "s"}*`
    );

  if (business.logo_url) menuEmbed.setThumbnail(business.logo_url);

  const components = [];

  if (items.length) {
    const multiMenu = new StringSelectMenuBuilder()
      .setCustomId(`shop_items:${c.id}:${business.id}:${page}`)
      .setPlaceholder("Select one or more items")
      .setMinValues(1)
      .setMaxValues(Math.min(items.length,25))
      .addOptions(items.map(item=>({
        label:item.item_name.slice(0,100),
        description:`${nova(item.price_voro)}${item.category ? ` • ${item.category}` : ""}`.slice(0,100),
        value:item.id
      })));
    components.push(new ActionRowBuilder().addComponents(multiMenu));
  }

  const pageButtons = [];
  if (page > 0) {
    pageButtons.push({
      id:`shop_page:${c.id}:${business.id}:${page - 1}`,
      label:"◀ Previous"
    });
  }
  if (page < totalPages - 1) {
    pageButtons.push({
      id:`shop_page:${c.id}:${business.id}:${page + 1}`,
      label:"Next ▶",
      style:ButtonStyle.Primary
    });
  }
  if (pageButtons.length) components.push(buttonRow(pageButtons));

  return respond(i,{embeds:[menuEmbed],components});
}


async function businessItemManagePage(i, businessId, mode = "remove", requestedPage = 0) {
  const PAGE_SIZE = 25;
  const actionLabel = mode === "edit" ? "Edit" : "Remove";

  const business = unwrap(await db.from("businesses")
    .select("id,name,business_type")
    .eq("id",businessId)
    .limit(1),"business item management")?.[0];

  if (!business) throw new Error("Business not found.");

  const countResult = await db.from("business_items")
    .select("id",{count:"exact",head:true})
    .eq("business_id",businessId)
    .eq("is_active",true);

  if (countResult.error) throw countResult.error;

  const totalItems = Number(countResult.count || 0);
  if (!totalItems) return respond(i,{content:"This business has no active items."});

  const totalPages = Math.max(1,Math.ceil(totalItems/PAGE_SIZE));
  const page = Math.max(0,Math.min(Number(requestedPage)||0,totalPages-1));
  const start = page*PAGE_SIZE;
  const end = start+PAGE_SIZE-1;

  const items = unwrap(await db.from("business_items")
    .select("id,item_name,price_voro,category,description")
    .eq("business_id",businessId)
    .eq("is_active",true)
    .order("category",{ascending:true})
    .order("item_name",{ascending:true})
    .range(start,end),`business ${mode} items page`) || [];

  const components = [
    selectRow(`business_${mode}_item:${businessId}:${page}`,`${actionLabel} an item`,items.map(x=>({
      label:x.item_name.slice(0,100),
      description:`${nova(x.price_voro)}${x.category ? ` • ${x.category}` : ""}`.slice(0,100),
      value:x.id
    })))
  ];

  const buttons=[];
  if (page>0) buttons.push({id:`business_${mode}_page:${businessId}:${page-1}`,label:"◀ Previous"});
  if (page<totalPages-1) buttons.push({id:`business_${mode}_page:${businessId}:${page+1}`,label:"Next ▶",style:ButtonStyle.Primary});
  if (buttons.length) components.push(buttonRow(buttons));

  return respond(i,{
    embeds:[new EmbedBuilder()
      .setTitle(`${actionLabel} Menu Item — ${business.name}`)
      .setDescription(`Choose an item below.\n\nPage **${page+1} of ${totalPages}** • **${totalItems} active items**`)],
    components
  });
}



async function manageHome(i) {
  if (!isModerator(i)) {
    const ids=await accessibleBusinessIds(i);
    if(!ids?.length) throw new Error("You do not own or manage a business.");

    return respond(i,{
      embeds:[new EmbedBuilder()
        .setTitle("⚙️ Manage John")
        .setDescription("Manage the businesses this character owns or manages.")],
      components:[buttonRow([
        {id:"manage_open:businesses",label:"Businesses",style:ButtonStyle.Primary}
      ])]
    });
  }

  return respond(i, {
    embeds:[new EmbedBuilder()
      .setTitle("⚙️ Manage John")
      .setDescription("Choose the system you want to manage.")],
    components:[
      buttonRow([
        {id:"manage_open:jobs",label:"Jobs"},
        {id:"manage_open:properties",label:"Properties"},
        {id:"manage_open:vehicles",label:"Vehicles"},
        {id:"manage_open:businesses",label:"Businesses"}
      ]),
      buttonRow([
        {id:"manage_open:subscriptions",label:"Subscriptions"},
        {id:"manage_open:characters",label:"Characters"}
      ])
    ]
  });
}



const INVENTORY_CATEGORY_LABELS = {
  all:"All Items", clothing:"Clothing", accessories:"Accessories",
  electronics:"Electronics", food_drink:"Food & Drink", beauty:"Beauty",
  toys_games:"Toys & Games", home:"Home Items",
  school_office:"School & Office", gifts:"Gifts", misc:"Miscellaneous"
};

async function inventoryHome(i,c,category="all") {
  let q=db.from("character_inventory")
    .select("id,item_name,category,quantity,source_type,source_name,gifted_by_character_id,acquired_at,is_consumable,characters!character_inventory_gifted_by_character_id_fkey(name)")
    .eq("character_id",c.id).eq("is_active",true)
    .order("acquired_at",{ascending:false}).limit(25);

  if(category!=="all") q=q.eq("category",category);
  const rows=unwrap(await q,"character inventory")||[];

  const description=rows.length ? rows.map(x=>{
    const qty=Number(x.quantity||1)>1?` ×${x.quantity}`:"";
    const source=x.source_name?` • ${x.source_name}`:"";
    const gifted=x.gifted_by_character_id?` • 🎁 from ${x.characters?.name||"another character"}`:"";
    return `**${x.item_name}**${qty}\n${INVENTORY_CATEGORY_LABELS[x.category]||x.category||"Miscellaneous"}${source}${gifted}`;
  }).join("\n\n").slice(0,3900)
  : category==="all" ? "This character doesn't have any inventory items yet."
  : `No ${INVENTORY_CATEGORY_LABELS[category]||category} items yet.`;

  const components=[selectRow(`inventory_filter:${c.id}`,"Filter inventory",[
    {label:"All Items",value:"all"},{label:"Clothing",value:"clothing"},
    {label:"Accessories",value:"accessories"},{label:"Electronics",value:"electronics"},
    {label:"Food & Drink",value:"food_drink"},{label:"Beauty",value:"beauty"},
    {label:"Toys & Games",value:"toys_games"},{label:"Home Items",value:"home"},
    {label:"School & Office",value:"school_office"},{label:"Gifts",value:"gifts"},
    {label:"Miscellaneous",value:"misc"}
  ])];

  if(rows.length){
    components.push(selectRow(`inventory_item:${c.id}`,"Choose an inventory item",rows.map(x=>({
      label:x.item_name.slice(0,100),
      description:`${INVENTORY_CATEGORY_LABELS[x.category]||x.category||"Misc"} • Qty ${x.quantity}`.slice(0,100),
      value:x.id
    }))));
  }

  return respond(i,{
    embeds:[new EmbedBuilder().setTitle(`🎒 ${c.name}'s Inventory`).setDescription(description)
      .setFooter({text:"Choose an item to Eat/Drink, Use, or Give."})],
    components
  });
}

async function inventoryItemDetail(i,c,inventoryId){
  const item=unwrap(await db.from("character_inventory")
    .select("id,character_id,item_name,category,quantity,source_name,is_consumable,is_active")
    .eq("id",inventoryId).eq("character_id",c.id).eq("is_active",true)
    .limit(1),"inventory item detail")?.[0];

  if(!item) throw new Error("That inventory item is no longer available.");
  const edible=item.category==="food_drink";
  const buttons=[];
  if(edible) buttons.push({id:`inventory_eat:${item.id}`,label:"Eat / Drink",style:ButtonStyle.Success});
  else buttons.push({id:`inventory_use:${item.id}`,label:"Use",style:ButtonStyle.Primary});
  buttons.push({id:`inventory_give:${item.id}`,label:"Give Item"});

  return respond(i,{
    embeds:[new EmbedBuilder().setTitle(`🎒 ${item.item_name}`)
      .setDescription(`Quantity: **${item.quantity}**${item.source_name?`\nFrom: **${item.source_name}**`:""}\nCategory: **${INVENTORY_CATEGORY_LABELS[item.category]||item.category||"Miscellaneous"}**${edible?"\n\n🍽️ This item can be eaten or drunk.":"\n\n🧰 This item can be used."}${!edible&&item.is_consumable?"\nUsing it consumes one.":""}`)],
    components:[buttonRow(buttons)]
  });
}

async function decrementInventoryItem(characterId,inventoryId,requireFood=false){
  const item=unwrap(await db.from("character_inventory")
    .select("id,item_name,category,quantity,is_consumable,is_active")
    .eq("id",inventoryId).eq("character_id",characterId).eq("is_active",true)
    .limit(1),"inventory action item")?.[0];

  if(!item) throw new Error("That inventory item is no longer available.");
  if(requireFood&&item.category!=="food_drink") throw new Error("That item is not food or drink.");

  let remaining=Number(item.quantity||1);
  if(remaining<=1){
    unwrap(await db.from("character_inventory").delete()
      .eq("id",item.id).eq("character_id",characterId),"remove last inventory item");
    remaining=0;
  }else{
    remaining-=1;
    unwrap(await db.from("character_inventory")
      .update({quantity:remaining,updated_at:new Date().toISOString()})
      .eq("id",item.id).eq("character_id",characterId),"decrement inventory item");
  }
  return {...item,remaining};
}

async function appSubmenu(i, appName, c) {
  const menus = {
    vantage: [
      {label:"Start Shopping",value:"shop"},
      {label:"View Cart",value:"cart"},
      {label:"Order History",value:"history"},
      {label:"Track Kinetix Delivery",value:"tracking"}
    ],
    vylt: [
      {label:"Send Nova",value:"send"},
      {label:"Request Nova",value:"request"},
      {label:"Activity",value:"activity"},
      {label:"VYLT Profile",value:"profile"}
    ],
    vybe: [
      {label:"Book a Ride",value:"book"},
      {label:"Scheduled Rides",value:"scheduled"},
      {label:"Ride History",value:"history"}
    ],
    nabit: [
      {label:"Place an Order",value:"order"},
      {label:"Track an Order",value:"tracking"},
      {label:"Order History",value:"history"}
    ]
  };

  const titles = {
    vantage:"VANTAGE",
    vylt:"VYLT",
    vybe:"VYBE",
    nabit:"NABIT"
  };

  return respond(i, {
    embeds:[new EmbedBuilder()
      .setTitle(`📱 ${titles[appName]}`)
      .setDescription(`Using **${c.name}**`)],
    components:[selectRow(`app_action:${appName}:${c.id}`,"Choose an option",menus[appName])]
  });
}

async function manageList(i, kind) {
  console.log(`[MANAGE LIST] loading ${kind} for ${i.user.id}`);
  const configs = {
    jobs: {table:"jobs", fields:"id,position,employer_name,status", label:r=>`${r.position} — ${r.employer_name}`},
    properties: {table:"properties", fields:"id,name,property_type,status", label:r=>r.name},
    vehicles: {table:"vehicles", fields:"id,name,year", label:r=>`${r.year ? r.year+" " : ""}${r.name}`},
    businesses: {table:"businesses", fields:"id,name,business_type,status,owner_character_id", label:r=>r.name},
    subscriptions: {table:"subscriptions", fields:"id,name,status", label:r=>r.name},
    characters: {table:"characters", fields:"id,name,owner_discord_id", label:r=>r.name}
  };

  const cfg = configs[kind];
  if (!cfg) throw new Error("Unknown management category.");

  if(!isModerator(i) && kind!=="businesses") {
    throw new Error("Moderator permissions required.");
  }

  let q=db.from(cfg.table).select(cfg.fields).limit(25);

  if(kind==="businesses" && !isModerator(i)) {
    const ids=await accessibleBusinessIds(i);
    if(!ids?.length) return respond(i,{content:"You do not own or manage a business."});
    q=q.in("id",ids);
  }

  const rows = unwrap(await q, `manage ${kind}`);

  if (!rows?.length) {
    return respond(i, {content:`There are no ${kind} to manage yet.`});
  }

  return respond(i, {
    content:`Choose a ${kind.slice(0,-1)}:`,
    components:[selectRow(`manage_item:${kind}`,"Choose an item",rows.map(r=>({
      label:cfg.label(r).slice(0,100),
      description:(r.status ? String(r.status) : "").slice(0,100),
      value:r.id
    })))]
  });
}

async function savePartTicket({characterId, accountId, transitType, ticketType, fareVoro, discountType, route, departure, arrival}) {
  const ticketId = randomId("PART");
  return unwrap(await db.from("part_tickets").insert({
    character_id: characterId,
    checking_account_id: accountId,
    ticket_id: ticketId,
    transit_type: transitType,
    ticket_type: ticketType,
    discount_type: discountType,
    fare_voro: fareVoro,
    route_name: route || "PAR-T",
    departure: departure || null,
    arrival: arrival || null,
    status: "booked"
  }).select().single(), "savePartTicket");
}

client.on(Events.InteractionCreate, async i => {
  if (!claimInteraction(i)) return;

  // /manage needs to be acknowledged before any other routing/logging work.
  // This gives Discord the earliest possible ACK and prevents the slash command
  // itself from timing out before the manage menu is rendered.
  if (
    i.isChatInputCommand?.() &&
    i.commandName === "manage" &&
    !i.deferred &&
    !i.replied
  ) {
    try {
      await i.deferReply({ flags: 64 });
      console.log(`[FAST SLASH PRE-ACK] /manage ${i.id}`);
    } catch (error) {
      if (error?.code === 10062 || error?.code === 40060) {
        console.warn(`[FAST SLASH PRE-ACK FAILED] /manage ${error.code} ${i.id}`);
        return;
      }
      throw error;
    }
  }

  // Inventory interactions are acknowledged immediately at the very top of
  // the event handler, before ANY character/database work or routing.
  if (
    (i.isButton?.() || i.isStringSelectMenu?.() || i.isUserSelectMenu?.()) &&
    typeof i.customId === "string" &&
    (
      i.customId.startsWith("inventory_") ||
      i.customId.startsWith("drive_") ||
      i.customId.startsWith("vehicle_") ||
      i.customId.startsWith("property_") ||
      i.customId.startsWith("vantage_") ||
      i.customId.startsWith("manage_")
    ) &&
    !i.deferred && !i.replied
  ) {
    try {
      await i.deferUpdate();
      console.log(`[FAST PRE-ACK] ${i.customId.split(":")[0]} ${i.id}`);
    } catch (error) {
      if (error?.code === 10062 || error?.code === 40060) {
        console.warn(`[FAST PRE-ACK FAILED] ${error.code} ${i.id}`);
        return;
      }
      throw error;
    }
  }

  // DIRECT /manage button router.
  // Handle manage_open immediately after its fast ACK instead of waiting for
  // the large general button router farther down in the file.
  if (
    i.isButton?.() &&
    typeof i.customId === "string" &&
    i.customId.startsWith("manage_open:")
  ) {
    try {
      const [, kind] = i.customId.split(":");
      console.log(`[MANAGE DIRECT ROUTER] kind=${kind} user=${i.user.id}`);

      if (!isModerator(i) && kind !== "businesses") {
        throw new Error("Moderator permissions required.");
      }

      return await manageList(i, kind);
    } catch (error) {
      console.error("[MANAGE DIRECT ROUTER ERROR]", error);

      const payload = {
        content:`⚠️ John couldn't open that management section: ${error.message || "Unknown error"}`
      };

      try {
        if (i.deferred) return await i.editReply(payload);
        if (i.replied) return await i.followUp(payload);
        return await i.reply({ ...payload, flags:64 });
      } catch (replyError) {
        console.error("[MANAGE DIRECT ROUTER REPLY ERROR]", replyError);
        return;
      }
    }
  }

  try {
    if (i.isChatInputCommand()) {
      console.log(`[COMMAND] /${i.commandName} from ${i.user.id}`);
      const dbHeavyCommands = new Set([
        "character","me","bank","vehicle","drive","property","job","inventory",
        "subscriptions","action","shop","apps","business","fire","manage","admin"
      ]);
      if (dbHeavyCommands.has(i.commandName) && !i.deferred && !i.replied) {
        try {
          await i.deferReply({ flags: 64 });
        } catch (error) {
          if (error?.code === 10062) {
            console.warn(`[Interaction expired before defer] /${i.commandName}`);
            return;
          }
          throw error;
        }
      }

      if (i.commandName === "character") return await showCharacters(i);
      if (i.commandName === "bank") return await bankHome(i, await currentCharacter(i));
      // /apps is deferred ephemerally above, so app setup (shopping/rides) stays private.
      if (i.commandName === "apps") return await appsHome(i, await currentCharacter(i));

      if (i.commandName === "me") {
        const c = await currentCharacter(i);
        const checking = await accountFor(c.id,"checking");
        const savings = await accountFor(c.id,"savings");
        return respond(i, {embeds:[new EmbedBuilder()
          .setTitle(`✨ ${c.name}`)
          .addFields(
            {name:`${BANK_NAME} Checking`,value:checking?nova(checking.balance_voro):"Not opened",inline:true},
            {name:"Savings",value:savings?nova(savings.balance_voro):"Not opened",inline:true}
          )]});
      }


      if (i.commandName === "clubs") {
        const c = await currentCharacter(i);
        let memberships = [];
        try {
          memberships = unwrap(await db.from("club_members")
            .select("id,club_id,role,status,clubs(id,name,preset_key,description,visibility,dues_type,dues_amount_voro,status)")
            .eq("character_id",c.id)
            .eq("status","active")
            .order("joined_at",{ascending:true}),"club memberships") || [];
        } catch (clubError) {
          console.warn("[Clubs] Club tables unavailable:", clubError.message);
          return respond(i,{content:"⚠️ The Clubs database tables are not installed yet. Run the Clubs SQL patch, then try `/clubs` again."});
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🤝 Clubs & Groups — ${c.name}`)
            .setDescription(memberships.length
              ? `You belong to **${memberships.length}** club${memberships.length===1?"":"s"}. Browse groups, view your memberships, or create one.`
              : "Browse groups, join one, or create your own.")],
          components:[buttonRow([
            {id:`clubs_browse:${c.id}`,label:"Browse Clubs",style:ButtonStyle.Primary},
            {id:`clubs_mine:${c.id}`,label:"My Clubs"},
            {id:`clubs_create:${c.id}`,label:"Create Club",style:ButtonStyle.Success}
          ])]
        });
      }

      if (i.commandName === "inventory") {
        const c = await currentCharacter(i);
        return await inventoryHome(i,c);
      }



      if (i.commandName === "vehicle") {
        const c = await currentCharacter(i);

        const owned = unwrap(await db.from("vehicles")
          .select("id,name,year,fuel_percent,condition_percent")
          .eq("character_id",c.id)
          .order("created_at"),"owned vehicles");

        const sharedRows = unwrap(await db.from("vehicle_access")
          .select("vehicle_id,can_drive,can_buy_gas,can_maintain,vehicles(id,name,year,fuel_percent,condition_percent,character_id)")
          .eq("character_id",c.id)
          .eq("status","active"),"shared vehicles");

        const lines = [];
        for (const v of (owned || [])) {
          lines.push(`🚘 **${v.year ? `${v.year} ` : ""}${v.name}** — Owner`);
        }
        for (const row of (sharedRows || [])) {
          if (row.vehicles && row.vehicles.character_id !== c.id) {
            lines.push(`🔑 **${row.vehicles.year ? `${row.vehicles.year} ` : ""}${row.vehicles.name}** — Shared (Full Access)`);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🚘 ${c.name}'s Garage`)
            .setDescription(lines.length ? lines.join("\n") : "No vehicles yet.")],
          components:[selectRow(`vehicle_menu:${c.id}`,"Vehicle options",[
            {label:"My Owned Vehicles",value:"owned"},
            {label:"Vehicles Shared With Me",value:"shared"},
            {label:"Buy Vehicle",description:"Browse unowned vehicles for sale",value:"marketplace"}
          ])]
        });
      }

      if (i.commandName === "drive") {
        const c = await currentCharacter(i);
        return respond(i, {content:"Where are you driving?",components:[selectRow(`drive_type:${c.id}`,"Choose trip",[
          {label:"Quick Errand",value:"quick_errand"},
          {label:"Around Town",value:"around_town"},
          {label:"Across Town",value:"across_town"},
          {label:"Road Trip",value:"road_trip"},
          {label:"Custom Distance",value:"custom"}
        ])]});
      }



      if (i.commandName === "job") {
        const c = await currentCharacter(i);
        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`💼 Jobs — ${c.name}`)
            .setDescription("Browse open job listings, apply for work, or view this character's jobs.")],
          components:[selectRow(`job_menu:${c.id}`,"Choose an option",[
            {label:"Job Listings",value:"listings"},
            {label:"My Jobs",value:"mine"}
          ])]
        });
      }

      if (i.commandName === "property") {
        const c = await currentCharacter(i);
        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🏠 Housing — ${c.name}`)
            .setDescription("Browse available housing or view this character's current home.")],
          components:[selectRow(`property_menu:${c.id}`,"Choose an option",[
            {label:"Property Listings",value:"available"},
            {label:"My Housing",value:"mine"}
          ])]
        });
      }


      // /shop is deferred ephemerally above, so browsing/cart/checkout stays private.
      if (i.commandName === "shop") {
        const c = await currentCharacter(i);

        const businesses = unwrap(await db.from("businesses")
          .select("id,name,business_type,status,logo_url")
          .in("business_type",["shop","restaurant"])
          .eq("status","open")
          .order("name",{ascending:true})
          .limit(25),"shop businesses") || [];

        if (!businesses.length) {
          return respond(i,{content:"There are no open shops or restaurants available right now."});
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🛍️ Shops & Restaurants")
            .setDescription(`Shopping as **${c.name}**\nChoose a business below to view its menu or catalog.`)],
          components:[selectRow(`shop_business:${c.id}`,"Choose a business",businesses.map(b=>({
            label:b.name.slice(0,100),
            description:(b.business_type === "restaurant" ? "Restaurant" : "Shop"),
            value:b.id
          })))]
        });
      }

      if (i.commandName === "subscriptions") {
        const c = await currentCharacter(i);
        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`📆 ${c.name}'s Subscriptions`)
            .setDescription("Browse the premade monthly catalog, view active plans, or interact with subscriptions through `/action`.")],
          components:[buttonRow([
            {id:`subscriptions_browse:${c.id}`,label:"Browse Plans",style:ButtonStyle.Primary},
            {id:`subscriptions_mine:${c.id}`,label:"My Subscriptions"}
          ])]
        });
      }

      if (i.commandName === "action") {
        const c = await currentCharacter(i);

        const activeJobs = unwrap(await db.from("jobs")
          .select("id,position,employer_name,pay_type,pay_schedule")
          .eq("character_id",c.id)
          .eq("status","active"),"active work jobs");

        const subs = unwrap(await db.from("subscriptions")
          .select("id,name,action_template_id,subscription_action_templates(id,action_name,is_active)")
          .eq("character_id",c.id)
          .eq("status","active"),"subs") || [];

        let clubMemberships = [];
        try {
          clubMemberships = unwrap(await db.from("club_members")
            .select("club_id,clubs(id,name,preset_key,status)")
            .eq("character_id",c.id)
            .eq("status","active"),"active clubs for action") || [];
        } catch (clubError) {
          console.warn("[Clubs] /action club lookup skipped:", clubError.message);
          clubMemberships = [];
        }

        const options = [];
        if (activeJobs?.some(j =>
          j.pay_type === "hourly" ||
          j.pay_type === "weekly" ||
          j.pay_type === "salary" ||
          j.pay_type === "random" ||
          String(j.pay_schedule || "").toLowerCase().includes("week")
        )) {
          options.push({label:"Work",description:"Work a paid shift / pay period",value:"work"});
        }

        for (const s of subs) {
          const t = s.subscription_action_templates;
          if (!t?.id || t.is_active === false) continue;
          options.push({
            label:(t.action_name || `Use ${s.name}`).slice(0,100),
            description:s.name.slice(0,100),
            value:`subscription:${s.id}`
          });
          if (options.length >= 25) break;
        }

        for (const membership of clubMemberships) {
          if (options.length >= 25) break;
          const club = membership.clubs;
          if (!club || club.status !== "active") continue;
          const preset = CLUB_PRESETS[club.preset_key] || CLUB_PRESETS.custom;
          options.push({
            label:`Club: ${club.name}`.slice(0,100),
            description:`${preset.label} activities`.slice(0,100),
            value:`club:${club.id}`
          });
        }

        if (!options.length) throw new Error("No actions are available for this character right now.");

        return respond(i,{
          content:"Choose an action:",
          components:[selectRow(`action_pick:${c.id}`,"Choose an action",options)]
        });
      }

      if (i.commandName === "create") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");
        return i.reply({flags:64,content:"What do you want to create?",components:[selectRow("create_kind","Choose",[
          {label:"Job",value:"job"},{label:"Property",value:"property"},{label:"Vehicle",value:"vehicle"},
          {label:"Business",value:"business"},{label:"Subscription",value:"subscription"}
        ])]});
      }

      if (i.commandName === "manage") {
        return await manageHome(i);
      }

      if (i.commandName === "admin") {
        return await adminHome(i);
      }


      if (i.commandName === "business") {
        const c = await currentCharacter(i);

        let q = db.from("businesses")
          .select("id,name,business_type,status,owner_character_id")
          .order("name",{ascending:true})
          .limit(25);

        if (!isModerator(i)) q = q.eq("owner_character_id",c.id);

        const businesses = unwrap(await q,"business command list") || [];

        if (!businesses.length) {
          return respond(i,{content:isModerator(i)
            ? "There are no businesses to manage yet."
            : `**${c.name}** does not own a business yet.`});
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🏪 Business Management")
            .setDescription("Choose a business to manage its menu/catalog, items, logo, and other settings.")],
          components:[selectRow(`business_manage_pick:${c.id}`,"Choose a business",businesses.map(b=>({
            label:b.name.slice(0,100),
            description:`${b.business_type === "restaurant" ? "Restaurant" : "Shop"} • ${b.status || "open"}`.slice(0,100),
            value:b.id
          })))]
        });
      }

      if (i.commandName === "fire") {
        return respond(i, {content:"Use your business employee list to select an employee, reason, and Immediate or End of Pay Period. The database firing patch is included in this package."});
      }

      return respond(i, {content:`✅ **${i.commandName}** is installed in John. This package includes the database foundation and interaction framework for this system.`});
    }

    if (i.isButton()) {
      const [id,arg] = i.customId.split(":");

      if (id === "bea") {
        const businessId=arg;
        const access=await businessManagementAccess(i,businessId,{ownerOnly:true});
        if(!i.deferred && !i.replied) await i.deferUpdate();
        return respond(i,{
          content:`👤 Choose the Discord user whose character you want to hire at **${access.business.name}**:`,
          components:[userSelectRow(`beu:${businessId}`,"Choose employee")]
        });
      }

      if (id === "bem") {
        const businessId=arg;
        await businessManagementAccess(i,businessId);
        if(!i.deferred && !i.replied) await i.deferUpdate();

        const jobs=unwrap(await db.from("jobs")
          .select("id,position,status,employment_role,characters(name)")
          .eq("business_id",businessId)
          .in("status",["pending","active","paused"])
          .order("created_at",{ascending:true})
          .limit(25),"manage business employees") || [];

        if(!jobs.length) return respond(i,{content:"This business has no employees to manage."});

        return respond(i,{
          content:"Choose an employee:",
          components:[selectRow(`bepick:${businessId}`,"Choose employee",jobs.map(j=>({
            label:`${j.characters?.name || "Character"} — ${j.position}`.slice(0,100),
            description:`${j.employment_role || "employee"} • ${j.status}`.slice(0,100),
            value:j.id
          })))]
        });
      }

      if (id === "bee") {
        const parts=i.customId.split(":");
        const businessId=parts[1];
        const jobId=parts[2];
        await businessManagementAccess(i,businessId,{ownerOnly:true});
        return i.showModal(modal(`beem:${businessId}:${jobId}`,"Edit Employee",[
          {id:"position",label:"New Position",required:false,placeholder:"Leave blank to keep current"},
          {id:"pay",label:"New Pay in Nova",required:false,placeholder:"18.00"},
          {id:"pay_type",label:"Pay Type",required:false,placeholder:"hourly or salary"},
          {id:"schedule",label:"Work Schedule",required:false,placeholder:"Mon-Fri, 8 AM-2 PM"},
          {id:"role",label:"Role",required:false,placeholder:"employee or manager"}
        ]));
      }

      if (id === "beprom") {
        const parts=i.customId.split(":");
        const businessId=parts[1];
        const jobId=parts[2];
        await businessManagementAccess(i,businessId,{ownerOnly:true});
        unwrap(await db.from("jobs").update({employment_role:"manager"}).eq("id",jobId).eq("business_id",businessId),"promote employee");
        return respond(i,{content:"✅ Employee promoted to **Manager**."});
      }

      if (id === "bedem") {
        const parts=i.customId.split(":");
        const businessId=parts[1];
        const jobId=parts[2];
        await businessManagementAccess(i,businessId,{ownerOnly:true});
        unwrap(await db.from("jobs").update({employment_role:"employee"}).eq("id",jobId).eq("business_id",businessId),"demote manager");
        return respond(i,{content:"✅ Manager changed back to **Employee**."});
      }

      if (id === "bef") {
        const parts=i.customId.split(":");
        const businessId=parts[1];
        const jobId=parts[2];
        await businessManagementAccess(i,businessId,{ownerOnly:true});
        return respond(i,{
          content:"⚠️ Fire this employee? Their job will be ended immediately.",
          components:[buttonRow([
            {id:`befc:${businessId}:${jobId}`,label:"Confirm Fire",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "befc") {
        const parts=i.customId.split(":");
        const businessId=parts[1];
        const jobId=parts[2];
        await businessManagementAccess(i,businessId,{ownerOnly:true});
        const job=unwrap(await db.from("jobs")
          .select("id,character_id,position,characters(name,owner_discord_id)")
          .eq("id",jobId).eq("business_id",businessId).limit(1),"fire employee")?.[0];
        if(!job) throw new Error("Employee job not found.");

        unwrap(await db.from("jobs").update({status:"ended"}).eq("id",jobId),"fire employee");
        try {
          if(job.characters?.owner_discord_id) {
            const user=await client.users.fetch(job.characters.owner_discord_id);
            await user.send(`💼 **${job.characters?.name || "Your character"}** is no longer employed as **${job.position}** at this business.`);
          }
        } catch {}

        return respond(i,{content:`✅ **${job.characters?.name || "Employee"}** was removed from the business.`});
      }

      if (id === "bdcp") {
        const businessId=arg;
        const access=await businessManagementAccess(i,businessId,{ownerOnly:true});
        return i.showModal(modal(`bdcm:${businessId}`,"Delete Entire Business",[
          {id:"confirm_name",label:`Type ${access.business.name} exactly`,placeholder:access.business.name}
        ]));
      }

      if (id === "character_create") {
        return i.showModal(modal("character_create_modal","Create Character",[
          {id:"name",label:"Character Name"}
        ]));
      }

      if (["character_switch","character_view","character_edit","character_remove"].includes(id)) {
        const opts = await characterOptions(i.user.id);
        if (!opts.length) return respond(i, {content:"You do not have any characters yet."});
        const action = id.replace("character_","");
        return respond(i, {content:`Choose a character to ${action}:`,components:[
          selectRow(`character_${action}_pick`,"Choose your character",opts)
        ]});
      }





      if (id === "vehicle_buy") {
        const parts = i.customId.split(":");
        const characterId = parts[1];
        const vehicleId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        if (!i.deferred && !i.replied) await i.deferUpdate();

        const result = unwrap(await db.rpc("purchase_marketplace_vehicle",{
          p_vehicle_id:vehicleId,
          p_character_id:c.id,
          p_discord_user_id:i.user.id
        }),"purchase marketplace vehicle");

        const purchase = Array.isArray(result) ? result[0] : result;
        if (!purchase) throw new Error("John couldn't complete the vehicle purchase.");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🎉 Vehicle Purchased!")
            .setDescription(`**${c.name}** now owns **${purchase.vehicle_name_out || "the vehicle"}**.`)
            .addFields(
              {name:"Price Paid",value:nova(purchase.price_voro_out),inline:true},
              {name:"Checking Balance",value:nova(purchase.balance_after_voro_out),inline:true}
            )
            .setFooter({text:"The vehicle has been removed from the marketplace and added to My Owned Vehicles."})]
        });
      }






      if (id === "business_remove_page" || id === "business_edit_page") {
        const parts = i.customId.split(":");
        const businessId = parts[1];
        const page = Number(parts[2] || 0);
        const mode = id === "business_edit_page" ? "edit" : "remove";

        if (!i.deferred && !i.replied) await i.deferUpdate();
        return await businessItemManagePage(i,businessId,mode,page);
      }



      if (id === "shop_cart_quantities") {
        const cart = getShopCart(arg);
        const c = await ensureOwnedCharacter(cart.buyerCharacterId,i.user.id);

        if (!i.deferred && !i.replied) await i.deferUpdate();

        const token = arg;
        const itemOptions = cart.items.map((item,index)=>({
          label:item.item_name.slice(0,100),
          description:`Current quantity: ${item.quantity}`.slice(0,100),
          value:String(index)
        }));

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🔢 Set Item Quantities")
            .setDescription("Choose an item, then enter how many you want.")],
          components:[selectRow(`shop_cart_quantity_item:${token}`,"Choose item",itemOptions)]
        });
      }

      if (id === "shop_cart_buy") {
        const cart = getShopCart(arg);
        const c = await ensureOwnedCharacter(cart.buyerCharacterId,i.user.id);

        if (!i.deferred && !i.replied) await i.deferUpdate();

        const itemIds = cart.items.map(x=>x.id);
        const items = unwrap(await db.from("business_items")
          .select("id,item_name,price_voro")
          .eq("business_id",cart.businessId)
          .eq("is_active",true)
          .in("id",itemIds),"checkout cart items") || [];

        const qtyMap = new Map(cart.items.map(x=>[x.id,Number(x.quantity||1)]));
        const totalVoro = items.reduce((sum,item)=>sum+(Number(item.price_voro||0)*Number(qtyMap.get(item.id)||1)),0);
        const checking = await requireChecking(c.id);

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🧾 Confirm Order")
            .setDescription(`${items.map(x=>`**${x.item_name}** — ${nova(x.price_voro)} × ${qtyMap.get(x.id)||1}`).join("\n")}\n\n────────────\n**Total: ${nova(totalVoro)}**`)
            .addFields({name:"Checking Balance",value:nova(checking.balance_voro),inline:true})],
          components:[buttonRow([
            {id:`shop_cart_confirm:${arg}`,label:`Confirm — ${nova(totalVoro)}`,style:ButtonStyle.Success},
            {id:`shop_page:${c.id}:${cart.businessId}:${cart.page || 0}`,label:"Cancel / Back"}
          ])]
        });
      }

      if (id === "shop_cart_confirm") {
        const cart = getShopCart(arg);
        const c = await ensureOwnedCharacter(cart.buyerCharacterId,i.user.id);

        if (!i.deferred && !i.replied) await i.deferUpdate();

        const result = unwrap(await db.rpc("purchase_business_items",{
          p_business_id:cart.businessId,
          p_item_ids:cart.items.map(x=>x.id),
          p_quantities:cart.items.map(x=>Number(x.quantity||1)),
          p_buyer_character_id:c.id,
          p_discord_user_id:i.user.id,
          p_recipient_character_id:c.id,
          p_is_gift:false
        }),"purchase business items");
        const r = Array.isArray(result)?result[0]:result;

        shopCarts.delete(arg);

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("✅ Order Complete")
            .setDescription(`**${r.item_count_out} item${Number(r.item_count_out)===1?"":"s"}** purchased from **${cart.businessName}**.\n\n**Total:** ${nova(r.total_voro_out)}\nEverything was added to **${c.name}'s Inventory**.`)
            .addFields({name:"Checking Balance",value:nova(r.balance_after_voro_out),inline:true})],
          components:[buttonRow([
            {id:`shop_page:${c.id}:${cart.businessId}:${cart.page || 0}`,label:"Keep Shopping",style:ButtonStyle.Primary}
          ])]
        });
      }

      if (id === "shop_cart_gift") {
        const cart = getShopCart(arg);
        const c = await ensureOwnedCharacter(cart.buyerCharacterId,i.user.id);

        if (!i.deferred && !i.replied) await i.deferUpdate();

        return respond(i,{
          content:"Choose the Discord user receiving this entire order:",
          components:[userSelectRow(`shop_cart_gift_user:${arg}`,"Choose recipient")]
        });
      }



      if (id === "drive_confirm") {
        const action = getShopToken(arg);
        const c = await ensureOwnedCharacter(action.driveCharacterId,i.user.id);

        const v = unwrap(await db.from("vehicles")
          .select("id,name,fuel_percent,condition_percent,character_id,is_active")
          .eq("id",action.vehicleId)
          .eq("is_active",true)
          .limit(1),"drive confirm vehicle")?.[0];

        if (!v) throw new Error("That vehicle is no longer available.");

        if (v.character_id !== c.id) {
          const access = unwrap(await db.from("vehicle_access")
            .select("id,can_drive,status")
            .eq("vehicle_id",v.id)
            .eq("character_id",c.id)
            .eq("status","active")
            .eq("can_drive",true)
            .limit(1),"drive confirm shared access")?.[0];
          if (!access) throw new Error("You no longer have permission to drive that vehicle.");
        }

        const currentFuel = Number(v.fuel_percent||0);
        const fuelUsed = Number(action.fuelUse||0);
        if (currentFuel < fuelUsed) throw new Error("There is not enough fuel for that trip.");

        const newFuel = Math.max(0,currentFuel-fuelUsed);
        const currentCondition = Number(v.condition_percent ?? 100);
        const wear = Math.max(1,Math.ceil(Number(action.miles||0)/100));
        const newCondition = Math.max(0,currentCondition-wear);

        unwrap(await db.from("vehicles")
          .update({
            fuel_percent:newFuel,
            condition_percent:newCondition
          })
          .eq("id",v.id),"complete drive");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("✅ Drive Complete")
            .setDescription(`**${c.name}** finished the **${action.tripLabel}** in **${v.name}**.`)
            .addFields(
              {name:"Distance",value:`${action.miles} miles`,inline:true},
              {name:"Fuel",value:`${Math.round(currentFuel)}% → ${Math.round(newFuel)}%`,inline:true},
              {name:"Condition",value:`${Math.round(currentCondition)}% → ${Math.round(newCondition)}%`,inline:true}
            )]
        });
      }

      if (id === "drive_cancel") {
        return respond(i,{content:"🚗 Drive cancelled."});
      }

      if (id === "shop_page") {
        const parts = i.customId.split(":");
        const c = await ensureOwnedCharacter(parts[1],i.user.id);
        const businessId = parts[2];
        const page = Number(parts[3] || 0);

        if (!i.deferred && !i.replied) await i.deferUpdate();
        return await shopPageView(i,c,businessId,page);
      }


      if (id === "shop_buy") {
        const token = arg;
        const action = getShopToken(token);
        const c = await ensureOwnedCharacter(action.buyerCharacterId,i.user.id);
        const businessId = action.businessId;
        const itemId = action.itemId;

        if (!i.deferred && !i.replied) await i.deferUpdate();

        const item = unwrap(await db.from("business_items")
          .select("id,item_name,price_voro,category,description,is_active")
          .eq("id",itemId)
          .eq("business_id",businessId)
          .eq("is_active",true)
          .limit(1),"checkout item")?.[0];

        const business = unwrap(await db.from("businesses")
          .select("id,name,status")
          .eq("id",businessId)
          .eq("status","open")
          .limit(1),"checkout business")?.[0];

        if (!item || !business) throw new Error("That item is no longer available.");

        const checking = await requireChecking(c.id);
        const confirmToken = makeShopToken({
          buyerCharacterId:c.id,
          businessId,
          itemId,
          page:action.page
        });

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🧾 Confirm Purchase")
            .setDescription(
              `**${item.item_name}**\n` +
              `${item.description ? `${item.description}\n\n` : "\n"}` +
              `**Business:** ${business.name}\n` +
              `**Price:** ${nova(item.price_voro)}\n` +
              `**Checking Balance:** ${nova(checking.balance_voro)}`
            )],
          components:[buttonRow([
            {id:`shop_buy_confirm:${confirmToken}`,label:`Confirm — ${nova(item.price_voro)}`,style:ButtonStyle.Success},
            {id:`shop_page:${c.id}:${businessId}:${action.page || 0}`,label:"Cancel / Back"}
          ])]
        });
      }

      if (id === "shop_buy_confirm") {
        const action = getShopToken(arg);
        const c = await ensureOwnedCharacter(action.buyerCharacterId,i.user.id);
        const businessId = action.businessId;
        const itemId = action.itemId;

        if (!i.deferred && !i.replied) await i.deferUpdate();

        const result = unwrap(await db.rpc("purchase_business_item",{
          p_business_id:businessId,
          p_item_id:itemId,
          p_buyer_character_id:c.id,
          p_discord_user_id:i.user.id,
          p_recipient_character_id:c.id,
          p_is_gift:false
        }),"purchase business item");
        const r = Array.isArray(result)?result[0]:result;

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("✅ Purchase Complete")
            .setDescription(
              `**${c.name}** bought **${r.item_name_out}** for **${nova(r.price_voro_out)}**.\n\n` +
              `It has been added to **${c.name}'s Inventory**.`
            )
            .addFields({name:"Checking Balance",value:nova(r.balance_after_voro_out),inline:true})],
          components:[buttonRow([
            {id:`shop_page:${c.id}:${businessId}:${action.page || 0}`,label:"Keep Shopping",style:ButtonStyle.Primary}
          ])]
        });
      }

      if (id === "shop_gift") {
        const action = getShopToken(arg);
        const c = await ensureOwnedCharacter(action.buyerCharacterId,i.user.id);

        if (!i.deferred && !i.replied) await i.deferUpdate();

        const giftToken = makeShopToken(action);

        return respond(i,{
          content:"Choose the Discord user receiving this gift:",
          components:[userSelectRow(`shop_gift_user:${giftToken}`,"Choose recipient")]
        });
      }


      if (id === "inventory_use") {
        console.log(`[BUTTON INVENTORY USE] item=${arg} user=${i.user.id}`);
        const c=await currentCharacter(i);

        const item=unwrap(await db.from("character_inventory")
          .select("id,item_name,category,quantity,is_consumable,is_active")
          .eq("id",arg).eq("character_id",c.id).eq("is_active",true)
          .limit(1),"use inventory item")?.[0];
        if(!item) throw new Error("That inventory item is no longer available.");

        let remaining=Number(item.quantity||1), consumed=false;
        if(item.is_consumable){
          consumed=true;
          const used=await decrementInventoryItem(c.id,item.id,false);
          remaining=used.remaining;
        }

        const reactions={
          clothing:[`${c.name} wore **${item.item_name}**.`,`${c.name} added **${item.item_name}** to the outfit.`],
          accessories:[`${c.name} used **${item.item_name}**.`,`${c.name} added **${item.item_name}** to the look.`],
          electronics:[`${c.name} used **${item.item_name}**. 🔌`,`${c.name} powered up **${item.item_name}**.`],
          beauty:[`${c.name} used **${item.item_name}**. ✨`,`${c.name} reached for **${item.item_name}**.`],
          toys_games:[`${c.name} used **${item.item_name}**. 🎮`,`${c.name} played with **${item.item_name}**.`],
          home:[`${c.name} used **${item.item_name}** around the house.`,`${c.name} put **${item.item_name}** to use at home.`],
          school_office:[`${c.name} used **${item.item_name}**. 📝`,`${c.name} put **${item.item_name}** to work.`],
          gifts:[`${c.name} used **${item.item_name}**.`,`${c.name} finally put **${item.item_name}** to use.`],
          misc:[`${c.name} used **${item.item_name}**.`,`${c.name} put **${item.item_name}** to use.`]
        };
        const pool=reactions[item.category]||reactions.misc;
        const reaction=pool[Math.floor(Math.random()*pool.length)];
        console.log(`[INVENTORY USE COMPLETE] item=${item.id} remaining=${remaining}`);

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle("🧰 Use Item")
            .setDescription(`${reaction}\n\n${consumed?`Remaining: **${remaining}**`:"This item stays in inventory."}`)],
          components:remaining>0
            ?[buttonRow([{id:`inventory_back_item:${item.id}`,label:"Back to Item"}])]
            :[buttonRow([{id:"inventory_back_home",label:"Back to Inventory"}])]
        });
      }

      if (id === "inventory_eat") {
        console.log(`[BUTTON INVENTORY EAT] item=${arg} user=${i.user.id}`);
        const c=await currentCharacter(i);
        const eaten=await decrementInventoryItem(c.id,arg,true);

        const reactions=[
          `${c.name} finished **${eaten.item_name}**. 😋`,
          `${c.name} had **${eaten.item_name}** and it hit the spot.`,
          `${c.name} ate/drank **${eaten.item_name}**.`,
          `${c.name} enjoyed **${eaten.item_name}**. 🍽️`,
          `${c.name} grabbed **${eaten.item_name}** and finished it.`
        ];
        const reaction=reactions[Math.floor(Math.random()*reactions.length)];
        console.log(`[INVENTORY EAT COMPLETE] item=${eaten.id} remaining=${eaten.remaining}`);

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle("🍽️ Eat / Drink")
            .setDescription(`${reaction}\n\nRemaining: **${eaten.remaining}**`)],
          components:eaten.remaining>0
            ?[buttonRow([{id:`inventory_back_item:${eaten.id}`,label:"Back to Item"}])]
            :[buttonRow([{id:"inventory_back_home",label:"Back to Inventory"}])]
        });
      }



      if (id === "vantage_add") {
        const action=getShopToken(arg);
        const c=await ensureOwnedCharacter(action.vantageCharacterId,i.user.id);
        const cart=await addVantageCartItem(c.id,i.user.id,action);

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle("✅ Added to Vantage Cart")
            .setDescription(`**${action.itemName}** was added.\n\nCart total: **${nova(vantageCartTotal(cart))}**`)],
          components:[buttonRow([
            {id:`vantage_view_cart:${c.id}`,label:"View Cart",style:ButtonStyle.Primary},
            {id:`vantage_continue:${c.id}`,label:"Keep Shopping"}
          ])]
        });
      }

      if (id === "vantage_buy_now") {
        const action=getShopToken(arg);
        const c=await ensureOwnedCharacter(action.vantageCharacterId,i.user.id);
        const account=await requireChecking(c.id);
        const total=Number(action.price_voro||0);

        if(Number(account.balance_voro)<total){
          throw new Error(`Not enough Nova in ${BANK_NAME} Checking.`);
        }

        const orderNumber=randomId("VAN");
        const items=[{
          category:action.category,
          size:action.size,
          name:action.itemName,
          price_voro:total,
          quantity:1
        }];

        const result=unwrap(await db.rpc("purchase_vantage_order",{
          p_character_id:c.id,
          p_discord_user_id:i.user.id,
          p_order_number:orderNumber,
          p_items:items,
          p_total_voro:total
        }),"purchase Vantage buy-now order");
        const r=Array.isArray(result)?result[0]:result;

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("✅ Thanks for your Vantage order!")
            .setDescription(`**Order ${r?.order_number_out||orderNumber}**\n**${action.itemName}** × 1\n\n**Total: ${nova(r?.total_voro_out||total)}**\n\n📦 **Kinetix:** Confirmed`)
            .setFooter({text:"Use Apps → Vantage → Track Kinetix Delivery to check the order."})]
        });
      }

      if (id === "vantage_view_cart") {
        const c=await ensureOwnedCharacter(arg,i.user.id);
        const cart=await loadVantageCart(c.id,i.user.id);
        if(!cart.items.length) return respond(i,{content:"🛒 Your Vantage cart is empty."});

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle("🛒 Vantage Cart")
            .setDescription(`${vantageCartLines(cart)}\n\n**Total: ${nova(vantageCartTotal(cart))}**`)],
          components:[buttonRow([
            {id:`vantage_checkout:${c.id}`,label:"Checkout",style:ButtonStyle.Success},
            {id:`vantage_clear:${c.id}`,label:"Clear Cart",style:ButtonStyle.Danger},
            {id:`vantage_continue:${c.id}`,label:"Keep Shopping"}
          ])]
        });
      }

      if (id === "vantage_clear") {
        const c=await ensureOwnedCharacter(arg,i.user.id);
        await clearVantageCart(c.id,i.user.id);
        return respond(i,{
          content:"🗑️ Vantage cart cleared.",
          components:[buttonRow([{id:`vantage_continue:${c.id}`,label:"Start Shopping",style:ButtonStyle.Primary}])]
        });
      }

      if (id === "vantage_continue") {
        const c=await ensureOwnedCharacter(arg,i.user.id);
        return respond(i,{content:"Choose a Vantage category:",components:[selectRow(`vantage_category:${c.id}`,"Choose category",[
          {label:"Electronics",value:"electronics"},{label:"Home",value:"home"},
          {label:"Clothing",value:"clothing"},{label:"Beauty",value:"beauty"},
          {label:"Toys & Games",value:"toys_games"},{label:"Office & School",value:"office_school"},
          {label:"Kitchen",value:"kitchen"},{label:"Furniture",value:"furniture"},
          {label:"Baby & Kids",value:"baby_kids"},{label:"Sports & Fitness",value:"sports_fitness"},
          {label:"Auto & Car Accessories",value:"auto"},{label:"Pet Supplies",value:"pet"},
          {label:"Jewelry & Accessories",value:"jewelry"},{label:"Miscellaneous",value:"misc"}
        ])]});
      }

      if (id === "vantage_checkout") {
        const c=await ensureOwnedCharacter(arg,i.user.id);
        const cart=await loadVantageCart(c.id,i.user.id);

        if(!cart.items.length) throw new Error("Your Vantage cart is empty.");

        const account=await requireChecking(c.id);
        const total=vantageCartTotal(cart);
        if(Number(account.balance_voro)<total){
          throw new Error(`Not enough Nova in ${BANK_NAME} Checking.`);
        }

        const orderNumber=randomId("VAN");
        const result=unwrap(await db.rpc("purchase_vantage_order",{
          p_character_id:c.id,
          p_discord_user_id:i.user.id,
          p_order_number:orderNumber,
          p_items:cart.items,
          p_total_voro:total
        }),"purchase Vantage order");
        const r=Array.isArray(result)?result[0]:result;

        await clearVantageCart(c.id,i.user.id);

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle("✅ Thanks for your Vantage order!")
            .setDescription(`**Order ${r?.order_number_out||orderNumber}**\n${vantageCartLines(cart)}\n\n**Total: ${nova(r?.total_voro_out||total)}**\n\n📦 **Kinetix:** Confirmed`)
            .setFooter({text:"Use Apps → Vantage → Track Kinetix Delivery to check the order."})]
        });
      }

      if (id === "business_owner_draw") {
        const businessId=arg;
        const c=await currentCharacter(i);
        const business=unwrap(await db.from("businesses")
          .select("id,name,owner_character_id")
          .eq("id",businessId).limit(1),"owner draw business")?.[0];
        if(!business) throw new Error("Business not found.");
        if(!isModerator(i) && business.owner_character_id!==c.id) throw new Error("Only the business owner can take an owner draw.");

        return i.showModal(modal(`business_owner_draw_modal:${businessId}`,"Owner Draw",[
          {id:"amount",label:"Amount in Nova",placeholder:"500.00"}
        ]));
      }

      if (id === "business_owner_salary") {
        const businessId=arg;
        const c=await currentCharacter(i);
        const business=unwrap(await db.from("businesses")
          .select("id,name,owner_character_id")
          .eq("id",businessId).limit(1),"owner salary business")?.[0];
        if(!business) throw new Error("Business not found.");
        if(!isModerator(i) && business.owner_character_id!==c.id) throw new Error("Only the business owner can set owner salary.");

        const current=unwrap(await db.from("business_owner_compensation")
          .select("salary_voro,schedule,status")
          .eq("business_id",businessId)
          .eq("owner_character_id",business.owner_character_id)
          .limit(1),"current owner salary")?.[0];

        return i.showModal(modal(`business_owner_salary_modal:${businessId}`,"Set Owner Salary",[
          {id:"amount",label:"Salary Amount in Nova",placeholder:"1500.00",value:current?.salary_voro ? (Number(current.salary_voro)/100).toFixed(2) : ""},
          {id:"schedule",label:"Schedule",placeholder:"weekly, biweekly, or monthly",value:current?.schedule || "weekly"}
        ]));
      }

      if (id === "business_owner_salary_off") {
        const businessId=arg;
        const c=await currentCharacter(i);
        const business=unwrap(await db.from("businesses")
          .select("id,name,owner_character_id")
          .eq("id",businessId).limit(1),"owner salary off business")?.[0];
        if(!business) throw new Error("Business not found.");
        if(!isModerator(i) && business.owner_character_id!==c.id) throw new Error("Only the business owner can change owner salary.");

        unwrap(await db.from("business_owner_compensation")
          .update({status:"inactive",updated_at:new Date().toISOString()})
          .eq("business_id",businessId)
          .eq("owner_character_id",business.owner_character_id),"disable owner salary");

        return respond(i,{content:`✅ Owner salary for **${business.name}** is turned off.`});
      }


      if (id === "inventory_give") {
        const c=await currentCharacter(i);
        const item=unwrap(await db.from("character_inventory")
          .select("id,character_id,item_name,quantity,is_active")
          .eq("id",arg).eq("character_id",c.id).eq("is_active",true)
          .limit(1),"inventory give item check")?.[0];
        if(!item) throw new Error("That inventory item is no longer available.");

        console.log(`[INVENTORY GIVE START] item=${item.id} character=${c.id}`);
        return respond(i,{
          content:`🎁 Who should receive **${item.item_name}**?`,
          components:[userSelectRow(`inventory_give_user:${item.id}`,"Choose recipient")]
        });
      }

      if (id === "inventory_back_item") {
        const c=await currentCharacter(i);
        return await inventoryItemDetail(i,c,arg);
      }

      if (id === "inventory_back_home") {
        const c=await currentCharacter(i);
        return await inventoryHome(i,c);
      }

      if (id === "clubs_browse") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        if (!i.deferred && !i.replied) await i.deferUpdate();

        const rows = unwrap(await db.from("clubs")
          .select("id,name,preset_key,description,visibility,dues_type,dues_amount_voro,member_limit,status")
          .eq("status","active")
          .in("visibility",["public","request"])
          .order("created_at",{ascending:false})
          .limit(25),"browse clubs") || [];

        if (!rows.length) return respond(i,{content:"There are no public clubs to browse yet."});

        return respond(i,{
          content:"Choose a club or group:",
          components:[selectRow(`club_browse_pick:${c.id}`,"Browse clubs",rows.map(club=>{
            const preset = CLUB_PRESETS[club.preset_key] || CLUB_PRESETS.custom;
            const dues = club.dues_type === "none" ? "No dues" : club.dues_type === "monthly"
              ? `${nova(club.dues_amount_voro||0)}/month`
              : `${nova(club.dues_amount_voro||0)} join fee`;
            return {label:club.name.slice(0,100),description:`${preset.label} • ${dues}`.slice(0,100),value:club.id};
          }))]
        });
      }

      if (id === "clubs_mine") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        if (!i.deferred && !i.replied) await i.deferUpdate();

        const rows = unwrap(await db.from("club_members")
          .select("id,club_id,role,status,clubs(id,name,preset_key,description,dues_type,dues_amount_voro,status)")
          .eq("character_id",c.id)
          .eq("status","active")
          .order("joined_at",{ascending:true}),"my clubs") || [];

        if (!rows.length) return respond(i,{content:`**${c.name}** is not in any clubs yet.`});

        return respond(i,{
          content:"Choose one of your clubs:",
          components:[selectRow(`club_my_pick:${c.id}`,"My clubs",rows.slice(0,25).map(m=>({
            label:m.clubs?.name?.slice(0,100)||"Club",
            description:`${m.role||"member"} • ${(CLUB_PRESETS[m.clubs?.preset_key]||CLUB_PRESETS.custom).label}`.slice(0,100),
            value:m.club_id
          })))]
        });
      }

      if (id === "clubs_create") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        if (!i.deferred && !i.replied) await i.deferUpdate();

        return respond(i,{
          content:"Choose the type of club/group you want to create:",
          components:[selectRow(`club_create_preset:${c.id}`,"Club type",Object.entries(CLUB_PRESETS).map(([key,p])=>({
            label:p.label.slice(0,100),description:p.description.slice(0,100),value:key
          })))]
        });
      }

      if (id === "club_join") {
        const parts = i.customId.split(":");
        const c = await ensureOwnedCharacter(parts[1],i.user.id);
        const clubId = parts[2];
        if (!i.deferred && !i.replied) await i.deferUpdate();

        const result = unwrap(await db.rpc("join_club",{p_club_id:clubId,p_character_id:c.id,p_discord_user_id:i.user.id}),"join club");
        const joined = Array.isArray(result)?result[0]:result;

        return respond(i,{content:joined?.membership_status_out==="pending"
          ? `📨 **${c.name}** requested to join **${joined.club_name_out}**.`
          : `✅ **${c.name}** joined **${joined?.club_name_out||"the club"}**${joined?.charged_voro_out?` and paid **${nova(joined.charged_voro_out)}**.`:"."}`});
      }

      if (id === "club_leave") {
        const parts = i.customId.split(":");
        const c = await ensureOwnedCharacter(parts[1],i.user.id);
        const clubId = parts[2];
        if (!i.deferred && !i.replied) await i.deferUpdate();

        unwrap(await db.rpc("leave_club",{p_club_id:clubId,p_character_id:c.id,p_discord_user_id:i.user.id}),"leave club");
        return respond(i,{content:`✅ **${c.name}** left the club.`});
      }

      if (id === "subscriptions_browse") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        if (!i.deferred && !i.replied) await i.deferUpdate();

        const plans = unwrap(await db.from("subscription_catalog")
          .select("id,name,category,tier,monthly_cost_voro,is_custom,description,status")
          .eq("status","active")
          .order("sort_order",{ascending:true})
          .limit(25),"subscription catalog") || [];

        if (!plans.length) return respond(i,{content:"There are no subscription plans available right now."});

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🛍️ Subscription Catalog")
            .setDescription("Choose a premade monthly plan. **Custom Subscription** stays available for moderator-created plans.")],
          components:[selectRow(`subscription_plan_pick:${c.id}`,"Choose a subscription",plans.map(p=>({
            label:p.name.slice(0,100),
            description:(p.is_custom
              ? "Custom plan — created by a moderator"
              : `${nova(p.monthly_cost_voro)}/month${p.tier ? ` • ${p.tier}` : ""}`).slice(0,100),
            value:p.id
          })))]
        });
      }

      if (id === "subscriptions_mine") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        if (!i.deferred && !i.replied) await i.deferUpdate();

        const rows = unwrap(await db.from("subscriptions")
          .select("id,name,tier,monthly_cost_voro,next_billing_at,status,subscription_action_templates(action_name)")
          .eq("character_id",c.id)
          .order("created_at",{ascending:false})
          .limit(25),"my subscriptions") || [];

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`📆 ${c.name}'s Subscriptions`)
            .setDescription(rows.length
              ? rows.map(s=>`**${s.name}**${s.tier ? ` — ${s.tier}` : ""}\\n${nova(s.monthly_cost_voro)}/month • **${s.status}**${s.next_billing_at ? ` • Next: <t:${Math.floor(new Date(s.next_billing_at).getTime()/1000)}:D>` : ""}${s.subscription_action_templates?.action_name ? `\\nInteraction: **${s.subscription_action_templates.action_name}**` : ""}`).join("\\n\\n")
              : "No subscriptions yet.")]
        });
      }

      if (id === "subscription_buy_confirm") {
        const parts = i.customId.split(":");
        const characterId = parts[1];
        const planId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);
        if (!i.deferred && !i.replied) await i.deferUpdate();

        const plan = unwrap(await db.from("subscription_catalog")
          .select("*")
          .eq("id",planId)
          .eq("status","active")
          .limit(1),"subscription purchase plan")?.[0];

        if (!plan) throw new Error("That subscription plan is no longer available.");
        if (plan.is_custom) throw new Error("Custom subscriptions are created through `/create → Subscription`.");

        const result = unwrap(await db.rpc("purchase_subscription_plan",{
          p_character_id:c.id,
          p_plan_id:plan.id,
          p_discord_user_id:i.user.id
        }),"purchase subscription plan");
        const bought = Array.isArray(result) ? result[0] : result;

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("✅ Subscription Activated")
            .setDescription(`**${c.name}** subscribed to **${plan.name}**.`)
            .addFields(
              {name:"Monthly Cost",value:nova(plan.monthly_cost_voro),inline:true},
              {name:"Paid Today",value:nova(plan.monthly_cost_voro),inline:true},
              {name:"Interaction",value:bought?.action_name_out || bought?.action_name || "Available through /action",inline:true}
            )
            .setFooter({text:"Use /action whenever you want to interact with this subscription."})]
        });
      }

      if (id === "job_withdraw_application") {
        const app = unwrap(await db.from("job_applications")
          .select("id,character_id,status")
          .eq("id",arg).limit(1),"withdraw application")?.[0];
        if (!app) throw new Error("Application not found.");
        await ensureOwnedCharacter(app.character_id,i.user.id);
        if (app.status !== "pending") throw new Error("Only pending applications can be withdrawn.");
        unwrap(await db.from("job_applications").update({status:"withdrawn"}).eq("id",app.id),"withdraw application");
        return respond(i,{content:"✅ Job application withdrawn."});
      }

      if (id === "job_work_now") {
        const parts = i.customId.split(":");
        const jobId = parts[1];
        const characterId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        const job = unwrap(await db.from("jobs").select("*").eq("id",jobId).eq("character_id",c.id).limit(1),"work now")?.[0];
        if (!job || job.status !== "active") throw new Error("That job is not active.");

        const result = unwrap(await db.rpc("claim_work_action",{
          p_job_id:job.id,
          p_character_id:c.id,
          p_discord_user_id:i.user.id
        }),"work action");

        const work = Array.isArray(result) ? result[0] : result;
        return respond(i,{
          content:`💼 **${c.name}** worked at **${job.employer_name}** and earned **${nova(work.payout_voro)}**.\n${work.outcome_side==="good"?"✨":"😵"} ${work.outcome_message}\nNext paid work: <t:${Math.floor(new Date(work.next_available_at).getTime()/1000)}:R>`
        });
      }

      if (id === "job_work_history") {
        const parts = i.customId.split(":");
        const jobId = parts[1];
        const characterId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        const rows = unwrap(await db.from("work_action_claims")
          .select("payout_voro,pay_period,outcome_side,outcome_message,claimed_at,next_available_at")
          .eq("job_id",jobId)
          .eq("character_id",c.id)
          .order("claimed_at",{ascending:false})
          .limit(10),"work history");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`💼 ${c.name} — Work History`)
            .setDescription(rows?.length ? rows.map(r =>
              `<t:${Math.floor(new Date(r.claimed_at).getTime()/1000)}:d> • **${nova(r.payout_voro)}** • ${r.outcome_side==="good"?"✨":"😵"} ${r.outcome_message}`
            ).join("\n\n") : "No paid work history yet.")]
        });
      }

      if (id === "job_apply") {
        const parts = i.customId.split(":");
        const generalJobId = parts[1];
        const characterId = parts[2];
        await ensureOwnedCharacter(characterId,i.user.id);

        const job = unwrap(await db.from("general_jobs")
          .select("id,position,employer_name,status")
          .eq("id",generalJobId)
          .limit(1),"job apply listing")?.[0];

        if (!job || job.status !== "open") throw new Error("That job listing is no longer open.");

        return i.showModal(modal(`job_apply_modal:${generalJobId}:${characterId}`,"Job Application",[
          {id:"age",label:"Character Age",required:false,placeholder:"24"},
          {id:"experience",label:"Experience",long:true,required:false,placeholder:"Previous work, skills, or relevant experience"},
          {id:"availability",label:"Availability",placeholder:"Mon-Fri after 3 PM"},
          {id:"why",label:"Why do they want this job?",long:true,placeholder:"Tell the employer why this character is applying"},
          {id:"notes",label:"Additional Information",long:true,required:false,placeholder:"Anything else the reviewer should know"}
        ]));
      }

      if (id === "job_contract_accept") {
        const jobId = arg;
        const contracts = unwrap(await db.from("job_contracts")
          .select("*")
          .eq("job_id",jobId)
          .limit(1),"job contract accept");
        const contract = contracts?.[0];
        if (!contract) throw new Error("Job contract not found.");
        if (contract.discord_user_id !== i.user.id) throw new Error("This employment contract is not for you.");
        if (contract.status !== "pending") return respond(i,{content:`This contract is already **${contract.status}**.`});

        unwrap(await db.from("job_contracts")
          .update({status:"accepted",accepted_at:new Date().toISOString()})
          .eq("id",contract.id),"accept job contract");
        unwrap(await db.from("jobs")
          .update({status:"active"})
          .eq("id",jobId),"activate job");

        const job = unwrap(await db.from("jobs")
          .select("*,characters(name)")
          .eq("id",jobId)
          .limit(1),"accepted job")?.[0];

        if (contract.offered_by_discord_id) {
          try {
            const sender = await client.users.fetch(contract.offered_by_discord_id);
            await sender.send({
              embeds:[new EmbedBuilder()
                .setTitle("✅ Job Offer Accepted")
                .setDescription(`**${job?.characters?.name || "The character"}** accepted the offer for **${job?.position || "the job"}** at **${job?.employer_name || "the employer"}**.`)
                .setFooter({text:"The job is now active."})]
            });
          } catch (e) {
            console.warn("[Job offer accepted notification failed]",e.message);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🎉 Congratulations!")
            .setDescription(`**${job?.characters?.name || "Your character"}** accepted the position of **${job?.position || "the job"}** at **${job?.employer_name || "the employer"}**.`)
            .setFooter({text:"Your job is now active in John."})]
        });
      }

      if (id === "job_contract_decline") {
        const jobId = arg;
        const contracts = unwrap(await db.from("job_contracts")
          .select("*")
          .eq("job_id",jobId)
          .limit(1),"job contract decline");
        const contract = contracts?.[0];
        if (!contract) throw new Error("Job contract not found.");
        if (contract.discord_user_id !== i.user.id) throw new Error("This employment contract is not for you.");
        if (contract.status !== "pending") return respond(i,{content:`This contract is already **${contract.status}**.`});

        const job = unwrap(await db.from("jobs")
          .select("*,characters(name)")
          .eq("id",jobId)
          .limit(1),"declined job")?.[0];

        unwrap(await db.from("job_contracts")
          .update({status:"declined"})
          .eq("id",contract.id),"decline job contract");
        unwrap(await db.from("jobs")
          .update({status:"ended"})
          .eq("id",jobId),"decline job");

        if (contract.offered_by_discord_id) {
          try {
            const sender = await client.users.fetch(contract.offered_by_discord_id);
            await sender.send({
              embeds:[new EmbedBuilder()
                .setTitle("❌ Job Offer Declined")
                .setDescription(`**${job?.characters?.name || "The character"}** declined the offer for **${job?.position || "the job"}** at **${job?.employer_name || "the employer"}**.`)]
            });
          } catch (e) {
            console.warn("[Job offer declined notification failed]",e.message);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("Job Offer Declined")
            .setDescription(`You declined the offer for **${job?.position || "the job"}** at **${job?.employer_name || "the employer"}**.`)]
        });
      }



      if (id === "admin_job_app_accept") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");

        const applicationId = arg;
        const app = unwrap(await db.from("job_applications")
          .select("*,characters(name,owner_discord_id),general_jobs(*)")
          .eq("id",applicationId)
          .eq("status","pending")
          .limit(1),"accept job application")?.[0];

        if (!app) throw new Error("That application is no longer pending.");
        const listing = app.general_jobs;
        if (!listing || listing.status !== "open") throw new Error("That job listing is no longer open.");

        const created = unwrap(await db.rpc("approve_general_job_application",{
          p_application_id:applicationId,
          p_admin_discord_id:i.user.id
        }),"approve job application");
        const result = Array.isArray(created) ? created[0] : created;

        let dmSent = false;
        try {
          const user = await client.users.fetch(app.characters.owner_discord_id);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("🎉 Congratulations!")
              .setDescription(`**${app.characters.name}**, your application for **${listing.position}** at **${listing.employer_name}** was approved!`)
              .addFields(
                {name:"Pay",value:listing.pay_type === "random" ? `${nova(listing.min_pay_voro)}–${nova(listing.max_pay_voro)} • random per Work` : `${nova(listing.pay_amount_voro)} • ${listing.pay_type}`,inline:true},
                {name:"Pay Schedule",value:listing.pay_schedule || "Not specified",inline:true}
              )
              .setFooter({text:"Accept the employment contract to activate the job."})],
            components:[buttonRow([
              {id:`job_contract_accept:${result.job_id}`,label:"Accept Job",style:ButtonStyle.Success},
              {id:`job_contract_decline:${result.job_id}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
          dmSent = true;
        } catch (e) {
          console.warn("[Approved job application DM failed]",e.message);
        }

        return respond(i,{
          content:`✅ Application approved. The job contract is pending.${listing.listing_type === "recurring" ? " This recurring listing stays open for more applicants." : " This single-opening listing is now closed."}${dmSent ? " The player was sent the contract by DM." : ""}`
        });
      }

      if (id === "admin_job_app_decline") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");

        const applicationId = arg;
        const app = unwrap(await db.from("job_applications")
          .select("id,character_id,general_job_id,characters(name,owner_discord_id),general_jobs(position,employer_name)")
          .eq("id",applicationId)
          .eq("status","pending")
          .limit(1),"decline job application")?.[0];

        if (!app) throw new Error("That application is no longer pending.");

        unwrap(await db.from("job_applications")
          .update({
            status:"declined",
            reviewed_by_discord_id:i.user.id,
            reviewed_at:new Date().toISOString()
          })
          .eq("id",applicationId),"decline job application");

        try {
          const user = await client.users.fetch(app.characters.owner_discord_id);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("Unfortunately...")
              .setDescription(`**${app.characters.name}**, your application for **${app.general_jobs?.position || "the job"}** at **${app.general_jobs?.employer_name || "the employer"}** was not selected this time.`)
              .setFooter({text:"You can still apply to other open positions in John."})]
          });
        } catch (e) {
          console.warn("[Declined job application DM failed]",e.message);
        }

        return respond(i,{content:"❌ Application declined."});
      }





      if (id === "joint_add_holder") {
        const parts = i.customId.split(":");
        const jointId = parts[1];
        const characterId = parts[2];
        await ensureOwnedCharacter(characterId,i.user.id);

        const membership = unwrap(await db.from("joint_account_members")
          .select("role,status")
          .eq("joint_account_id",jointId)
          .eq("character_id",characterId)
          .eq("status","active")
          .limit(1),"joint owner check")?.[0];

        if (!membership || membership.role !== "owner") throw new Error("Only the joint account owner can add another holder.");

        return respond(i,{
          content:"Choose the Discord user you want to invite:",
          components:[userSelectRow(`joint_add_user:${jointId}:${characterId}`,"Choose user")]
        });
      }

      if (id === "joint_manage_holders") {
        const parts = i.customId.split(":");
        const jointId = parts[1];
        const characterId = parts[2];
        await ensureOwnedCharacter(characterId,i.user.id);

        const members = unwrap(await db.from("joint_account_members")
          .select("id,character_id,role,can_deposit,can_withdraw,can_transfer,status,characters(name)")
          .eq("joint_account_id",jointId)
          .eq("status","active")
          .order("joined_at"),"joint members");

        if (!members?.length) throw new Error("No active joint holders found.");

        return respond(i,{
          content:"Choose a joint holder to manage:",
          components:[selectRow(`joint_holder_pick:${jointId}:${characterId}`,"Choose holder",members.map(m=>({
            label:`${m.characters?.name || "Character"}${m.role==="owner" ? " (Owner)" : ""}`.slice(0,100),
            description:`Deposit ${m.can_deposit?"✓":"✗"} • Withdraw ${m.can_withdraw?"✓":"✗"} • Transfer ${m.can_transfer?"✓":"✗"}`,
            value:m.id
          })))]
        });
      }

      if (id === "joint_rename") {
        const parts = i.customId.split(":");
        const jointId = parts[1];
        const characterId = parts[2];
        await ensureOwnedCharacter(characterId,i.user.id);
        return i.showModal(modal(`joint_rename_modal:${jointId}:${characterId}`,"Rename Joint Account",[
          {id:"name",label:"New Account Name",placeholder:"Household Checking"}
        ]));
      }

      if (id === "joint_close") {
        const parts = i.customId.split(":");
        const jointId = parts[1];
        const characterId = parts[2];
        await ensureOwnedCharacter(characterId,i.user.id);

        return respond(i,{
          content:"Closing a joint account requires every active holder to approve. Start a closure request?",
          components:[buttonRow([
            {id:`joint_close_request:${jointId}:${characterId}`,label:"Request Closure",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "joint_close_request") {
        const parts = i.customId.split(":");
        const jointId = parts[1];
        const characterId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        const result = unwrap(await db.rpc("create_joint_close_request",{
          p_joint_account_id:jointId,
          p_requester_character_id:c.id,
          p_requester_discord_id:i.user.id
        }),"joint close request");
        const req = Array.isArray(result) ? result[0] : result;

        const approvals = unwrap(await db.from("joint_close_approvals")
          .select("id,character_id,discord_user_id,status,characters(name)")
          .eq("request_id",req.request_id),"joint close approvals");

        for (const approval of approvals || []) {
          if (approval.character_id === c.id) continue;
          try {
            const u = await client.users.fetch(approval.discord_user_id);
            await u.send({
              content:`🏦 **${c.name}** wants to close a joint Equity Financial account. Approve?`,
              components:[buttonRow([
                {id:`joint_close_accept:${approval.id}`,label:"Approve Closure",style:ButtonStyle.Success},
                {id:`joint_close_decline:${approval.id}`,label:"Decline",style:ButtonStyle.Danger}
              ])]
            });
          } catch {}
        }

        return respond(i,{content:"📨 Joint account closure request sent. The account stays open until all holders agree."});
      }

      if (id === "joint_close_accept") {
        const approval = unwrap(await db.from("joint_close_approvals")
          .select("id,request_id,character_id,characters(name),joint_close_requests(requester_discord_id,joint_account_id,joint_accounts(name))")
          .eq("id",arg)
          .limit(1),"joint close approval detail")?.[0];

        const result = unwrap(await db.rpc("respond_joint_close_approval",{
          p_approval_id:arg,
          p_discord_user_id:i.user.id,
          p_decision:"accepted"
        }),"joint close approval");
        const r = Array.isArray(result) ? result[0] : result;

        const requesterId = approval?.joint_close_requests?.requester_discord_id;
        if (requesterId && requesterId !== i.user.id) {
          try {
            const requester = await client.users.fetch(requesterId);
            await requester.send({
              embeds:[new EmbedBuilder()
                .setTitle("✅ Joint Account Closure Approved")
                .setDescription(`**${approval?.characters?.name || "A joint holder"}** approved your request to close **${approval?.joint_close_requests?.joint_accounts?.name || "the joint account"}**.${r?.closed ? "\n\n**Everyone has approved, so the account is now closed.**" : "\n\nJohn is still waiting for the remaining holder(s)."}`)]
            });
          } catch (e) {
            console.warn("[Joint close requester accept notification failed]",e.message);
          }
        }

        return respond(i,{content:r?.closed ? "✅ Everyone approved. The joint account is now closed." : "✅ Closure approved. Waiting for the remaining holder(s)."});
      }

      if (id === "joint_close_decline") {
        const approval = unwrap(await db.from("joint_close_approvals")
          .select("id,request_id,character_id,characters(name),joint_close_requests(requester_discord_id,joint_account_id,joint_accounts(name))")
          .eq("id",arg)
          .limit(1),"joint close decline detail")?.[0];

        unwrap(await db.rpc("respond_joint_close_approval",{
          p_approval_id:arg,
          p_discord_user_id:i.user.id,
          p_decision:"declined"
        }),"joint close decline");

        const requesterId = approval?.joint_close_requests?.requester_discord_id;
        if (requesterId && requesterId !== i.user.id) {
          try {
            const requester = await client.users.fetch(requesterId);
            await requester.send({
              embeds:[new EmbedBuilder()
                .setTitle("❌ Joint Account Closure Declined")
                .setDescription(`**${approval?.characters?.name || "A joint holder"}** declined your request to close **${approval?.joint_close_requests?.joint_accounts?.name || "the joint account"}**.\n\nThe account will remain open.`)]
            });
          } catch (e) {
            console.warn("[Joint close requester decline notification failed]",e.message);
          }
        }

        return respond(i,{content:"❌ Joint account closure declined. The account remains open."});
      }

      if (id === "bank_close_personal") {
        const parts = i.customId.split(":");
        const characterId = parts[1];
        const accountId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        const result = unwrap(await db.rpc("close_personal_bank_account",{
          p_account_id:accountId,
          p_character_id:c.id,
          p_discord_user_id:i.user.id
        }),"close personal bank account");
        const r = Array.isArray(result) ? result[0] : result;

        return respond(i,{content:`✅ ${r.account_type} account closed.${Number(r.cash_moved_voro||0)>0 ? ` ${nova(r.cash_moved_voro)} was moved to ${c.name}'s cash.` : ""}`});
      }

      if (id === "joint_cashout_request") {
        const parts = i.customId.split(":");
        const characterId = parts[1];
        const accountId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        const result = unwrap(await db.rpc("create_joint_cashout_request",{
          p_bank_account_id:accountId,
          p_requester_character_id:c.id,
          p_requester_discord_id:i.user.id
        }),"create joint cashout request");

        const request = Array.isArray(result) ? result[0] : result;
        if (!request?.request_id) throw new Error("John couldn't create the joint cash-out request.");

        const approvals = unwrap(await db.from("joint_cashout_approvals")
          .select("id,character_id,discord_user_id,share_voro,status,characters(name)")
          .eq("request_id",request.request_id)
          .order("created_at"),"joint cashout approvals");

        let sent = 0;
        for (const approval of (approvals || [])) {
          if (approval.character_id === c.id) continue;
          try {
            const user = await client.users.fetch(approval.discord_user_id);
            await user.send({
              embeds:[new EmbedBuilder()
                .setTitle("💵 Equity Financial — Joint Cash Out Approval")
                .setDescription(`**${c.name}** requested to cash out and split the full balance of a joint account.`)
                .addFields(
                  {name:"Your Share",value:nova(approval.share_voro),inline:true},
                  {name:"Total Being Cashed Out",value:nova(request.total_voro),inline:true}
                )
                .setFooter({text:"Nothing moves unless every other active joint holder agrees."})],
              components:[buttonRow([
                {id:`joint_cashout_accept:${approval.id}`,label:"Approve Split Cash Out",style:ButtonStyle.Success},
                {id:`joint_cashout_decline:${approval.id}`,label:"Decline",style:ButtonStyle.Danger}
              ])]
            });
            sent++;
          } catch (e) {
            console.warn("[Joint cashout approval DM failed]",e.message);
          }
        }

        return respond(i,{
          content:`📨 Split cash-out request created for **${nova(request.total_voro)}**. ${sent} approval request${sent===1?"":"s"} sent. John will only move the Nova after every other joint holder approves.`
        });
      }

      if (id === "joint_cashout_accept") {
        const approvalId = arg;

        const result = unwrap(await db.rpc("respond_joint_cashout_approval",{
          p_approval_id:approvalId,
          p_discord_user_id:i.user.id,
          p_decision:"accepted"
        }),"approve joint cashout");

        const response = Array.isArray(result) ? result[0] : result;

        if (response?.executed) {
          return respond(i,{
            content:`✅ You approved it. Everyone has now agreed, so the joint account was cashed out and **${nova(response.total_voro)}** was divided between the account holders.`
          });
        }

        return respond(i,{
          content:"✅ You approved the split cash out. John is still waiting for the remaining joint holder approval(s)."
        });
      }

      if (id === "joint_cashout_decline") {
        const approvalId = arg;

        unwrap(await db.rpc("respond_joint_cashout_approval",{
          p_approval_id:approvalId,
          p_discord_user_id:i.user.id,
          p_decision:"declined"
        }),"decline joint cashout");

        return respond(i,{
          content:"❌ You declined the split cash out. The request was cancelled and no Nova was moved."
        });
      }

      if (id === "bank_cashout_confirm") {
        const parts = i.customId.split(":");
        const characterId = parts[1];
        const accountId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        const result = unwrap(await db.rpc("cash_out_accessible_account",{
          p_account_id:accountId,
          p_character_id:c.id,
          p_discord_user_id:i.user.id
        }),"cash out account");

        const cashout = Array.isArray(result) ? result[0] : result;
        if (!cashout) throw new Error("John couldn't complete the cash out.");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("💵 Equity Financial — Cash Out Complete")
            .setDescription(`**${c.name}** cashed out **${nova(cashout.amount_voro)}** from **${cashout.account_label}**.`)
            .addFields(
              {name:"Bank Balance",value:nova(0),inline:true},
              {name:"Cash Balance",value:nova(cashout.cash_balance_voro),inline:true},
              {name:"Reference",value:cashout.reference_number || "—",inline:false}
            )
            .setFooter({text:"The account remains open."})]
        });
      }

      if (id === "bank_cashout_cancel") {
        await ensureOwnedCharacter(arg,i.user.id);
        return respond(i,{content:"Cash out cancelled."});
      }

      if (id === "bank_joint") {
        const c = await ensureOwnedCharacter(arg,i.user.id);

        const memberships = unwrap(await db.from("joint_account_members")
          .select("joint_account_id,role,status,joint_accounts(id,name,account_type,bank_account_id,bank_accounts(balance_voro,status))")
          .eq("character_id",c.id)
          .eq("status","active"),"joint accounts");

        const outgoing = unwrap(await db.from("joint_account_invites")
          .select("id,name,account_type,status,invited_character_id,characters!joint_account_invites_invited_character_id_fkey(name)")
          .eq("owner_character_id",c.id)
          .eq("status","pending")
          .order("created_at",{ascending:false}),"outgoing joint invites");

        const incoming = unwrap(await db.from("joint_account_invites")
          .select("id,name,account_type,status,owner_character_id,characters!joint_account_invites_owner_character_id_fkey(name)")
          .eq("invited_character_id",c.id)
          .eq("status","pending")
          .order("created_at",{ascending:false}),"incoming joint invites");

        const sections = [];

        if (memberships?.length) {
          sections.push("**Active Accounts**\n" + memberships.map(m => {
            const j = m.joint_accounts;
            return `• **${j?.name || "Joint Account"}** • ${j?.account_type || ""} • ${nova(j?.bank_accounts?.balance_voro || 0)} • ${m.role}`;
          }).join("\n"));
        }

        if (outgoing?.length) {
          sections.push("**Pending Invitations You Sent**\n" + outgoing.map(x =>
            `• **${x.name}** (${x.account_type}) → ${x.characters?.name || "Character"}`
          ).join("\n"));
        }

        if (incoming?.length) {
          sections.push("**Invitations Waiting on You**\n" + incoming.map(x =>
            `• **${x.name}** (${x.account_type}) from ${x.characters?.name || "Character"}`
          ).join("\n"));
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🏦 Equity Financial — Joint Accounts")
            .setDescription(sections.length ? sections.join("\n\n") : "This character has no joint accounts or pending invitations.")],
          components:[buttonRow([
            {id:`joint_create:${c.id}`,label:"Create Joint Account",style:ButtonStyle.Success}
          ])]
        });
      }

      if (id === "joint_create") {
        await ensureOwnedCharacter(arg,i.user.id);
        return respond(i,{
          content:"Choose the Discord user you want to share the account with:",
          components:[userSelectRow(`joint_user:${arg}`,"Choose joint account holder")]
        });
      }



      if (id === "joint_holder_invite_accept") {
        const result = unwrap(await db.rpc("accept_existing_joint_holder_invite",{
          p_invite_id:arg,
          p_discord_user_id:i.user.id
        }),"accept joint holder invite");
        const r = Array.isArray(result) ? result[0] : result;
        return respond(i,{content:`✅ Joint account invitation accepted${r?.account_name ? ` for **${r.account_name}**` : ""}.`});
      }

      if (id === "joint_holder_invite_decline") {
        unwrap(await db.rpc("decline_existing_joint_holder_invite",{
          p_invite_id:arg,
          p_discord_user_id:i.user.id
        }),"decline joint holder invite");
        return respond(i,{content:"❌ Joint account invitation declined."});
      }

      if (id === "joint_toggle_withdraw") {
        const result = unwrap(await db.rpc("toggle_joint_member_permission",{
          p_member_id:arg,
          p_actor_discord_id:i.user.id,
          p_permission:"withdraw"
        }),"toggle joint withdraw");
        const r = Array.isArray(result) ? result[0] : result;
        return respond(i,{content:`✅ Withdraw permission is now **${r.enabled ? "ON" : "OFF"}**.`});
      }

      if (id === "joint_toggle_transfer") {
        const result = unwrap(await db.rpc("toggle_joint_member_permission",{
          p_member_id:arg,
          p_actor_discord_id:i.user.id,
          p_permission:"transfer"
        }),"toggle joint transfer");
        const r = Array.isArray(result) ? result[0] : result;
        return respond(i,{content:`✅ Transfer permission is now **${r.enabled ? "ON" : "OFF"}**.`});
      }

      if (id === "joint_remove_holder") {
        unwrap(await db.rpc("remove_joint_member",{
          p_member_id:arg,
          p_actor_discord_id:i.user.id
        }),"remove joint holder");
        return respond(i,{content:"✅ Joint account holder removed."});
      }

      if (id === "joint_invite_accept") {
        const inviteId = arg;
        const result = unwrap(await db.rpc("accept_joint_account_invite",{
          p_invite_id:inviteId,
          p_discord_user_id:i.user.id
        }),"accept joint account invite");

        const accepted = Array.isArray(result) ? result[0] : result;
        if (!accepted?.joint_account_id) throw new Error("John couldn't activate the joint account.");

        return respond(i,{
          content:`✅ Joint account accepted. **${accepted.account_name}** is now active at Equity Financial with both characters as account holders.`
        });
      }

      if (id === "joint_invite_decline") {
        const inviteId = arg;
        const result = unwrap(await db.rpc("decline_joint_account_invite",{
          p_invite_id:inviteId,
          p_discord_user_id:i.user.id
        }),"decline joint account invite");

        const declined = Array.isArray(result) ? result[0] : result;

        return respond(i,{
          content:`❌ Joint account invitation declined${declined?.account_name ? ` for **${declined.account_name}**` : ""}. No joint account was opened.`
        });
      }



      if (id === "vehicle_share_accept") {
        const invite = unwrap(await db.from("vehicle_share_invites")
          .select("id,vehicle_id,owner_character_id,member_character_id,member_discord_id,vehicles(name)")
          .eq("id",arg).limit(1),"vehicle share invite detail")?.[0];
        if (!invite || invite.member_discord_id !== i.user.id) throw new Error("This vehicle share invitation is not for you.");

        const result = unwrap(await db.rpc("accept_vehicle_share_invite",{
          p_invite_id:arg,
          p_discord_user_id:i.user.id
        }),"accept vehicle share invite");
        const r = Array.isArray(result) ? result[0] : result;

        const owner = await characterById(invite.owner_character_id);
        const member = await characterById(invite.member_character_id);

        if (owner?.owner_discord_id) {
          try {
            const ownerUser = await client.users.fetch(owner.owner_discord_id);
            await ownerUser.send({
              embeds:[new EmbedBuilder()
                .setTitle("✅ Vehicle Share Accepted")
                .setDescription(`**${member?.name || "The invited character"}** accepted access to **${invite.vehicles?.name || "your vehicle"}**.`)]
            });
          } catch (e) {
            console.warn("[Vehicle share owner acceptance notification failed]",e.message);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🎉 Vehicle Access Accepted!")
            .setDescription(`**${member?.name || "Your character"}** now has access to **${invite.vehicles?.name || "the vehicle"}**.`)
            .addFields({name:"Shared Access",value:"Drive • Buy Gas • Maintenance"})]
        });
      }

      if (id === "vehicle_share_decline") {
        const invite = unwrap(await db.from("vehicle_share_invites")
          .select("id,vehicle_id,owner_character_id,member_character_id,member_discord_id,vehicles(name)")
          .eq("id",arg).limit(1),"vehicle share decline detail")?.[0];
        if (!invite || invite.member_discord_id !== i.user.id) throw new Error("This vehicle share invitation is not for you.");

        unwrap(await db.rpc("decline_vehicle_share_invite",{
          p_invite_id:arg,
          p_discord_user_id:i.user.id
        }),"decline vehicle share invite");

        const owner = await characterById(invite.owner_character_id);
        const member = await characterById(invite.member_character_id);

        if (owner?.owner_discord_id) {
          try {
            const ownerUser = await client.users.fetch(owner.owner_discord_id);
            await ownerUser.send({
              embeds:[new EmbedBuilder()
                .setTitle("❌ Vehicle Share Declined")
                .setDescription(`**${member?.name || "The invited character"}** declined access to **${invite.vehicles?.name || "your vehicle"}**.`)]
            });
          } catch (e) {
            console.warn("[Vehicle share owner decline notification failed]",e.message);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("Vehicle Share Declined")
            .setDescription(`You declined access to **${invite.vehicles?.name || "the vehicle"}**.`)]
        });
      }

      if (id === "vehicle_transfer_accept") {
        const invite = unwrap(await db.from("vehicle_transfer_invites")
          .select("id,vehicle_id,from_character_id,to_character_id,to_discord_id,vehicles(name)")
          .eq("id",arg).limit(1),"vehicle transfer invite detail")?.[0];
        if (!invite || invite.to_discord_id !== i.user.id) throw new Error("This vehicle transfer is not for you.");

        unwrap(await db.rpc("accept_vehicle_transfer_invite",{
          p_invite_id:arg,
          p_discord_user_id:i.user.id
        }),"accept vehicle transfer invite");

        const oldOwner = await characterById(invite.from_character_id);
        const newOwner = await characterById(invite.to_character_id);

        if (oldOwner?.owner_discord_id) {
          try {
            const ownerUser = await client.users.fetch(oldOwner.owner_discord_id);
            await ownerUser.send({
              embeds:[new EmbedBuilder()
                .setTitle("✅ Vehicle Transfer Accepted")
                .setDescription(`**${newOwner?.name || "The new owner"}** accepted ownership of **${invite.vehicles?.name || "the vehicle"}**.`)
                .setFooter({text:"Ownership has officially transferred."})]
            });
          } catch (e) {
            console.warn("[Vehicle transfer owner acceptance notification failed]",e.message);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🎉 Congratulations — New Vehicle!")
            .setDescription(`**${newOwner?.name || "Your character"}** is now the owner of **${invite.vehicles?.name || "the vehicle"}**.`)]
        });
      }

      if (id === "vehicle_transfer_decline") {
        const invite = unwrap(await db.from("vehicle_transfer_invites")
          .select("id,vehicle_id,from_character_id,to_character_id,to_discord_id,vehicles(name)")
          .eq("id",arg).limit(1),"vehicle transfer decline detail")?.[0];
        if (!invite || invite.to_discord_id !== i.user.id) throw new Error("This vehicle transfer is not for you.");

        unwrap(await db.rpc("decline_vehicle_transfer_invite",{
          p_invite_id:arg,
          p_discord_user_id:i.user.id
        }),"decline vehicle transfer invite");

        const oldOwner = await characterById(invite.from_character_id);
        const newOwner = await characterById(invite.to_character_id);

        if (oldOwner?.owner_discord_id) {
          try {
            const ownerUser = await client.users.fetch(oldOwner.owner_discord_id);
            await ownerUser.send({
              embeds:[new EmbedBuilder()
                .setTitle("❌ Vehicle Transfer Declined")
                .setDescription(`**${newOwner?.name || "The recipient"}** declined ownership of **${invite.vehicles?.name || "the vehicle"}**.`)
                .setFooter({text:"The vehicle remains with the original owner."})]
            });
          } catch (e) {
            console.warn("[Vehicle transfer owner decline notification failed]",e.message);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("Vehicle Transfer Declined")
            .setDescription(`You declined ownership of **${invite.vehicles?.name || "the vehicle"}**.`)]
        });
      }

      if (id === "vehicle_manage_shares") {
        const vehicleId = arg;
        const vehicle = unwrap(await db.from("vehicles").select("id,character_id,name").eq("id",vehicleId).limit(1),"vehicle manage shares")?.[0];
        await ensureOwnedCharacter(vehicle.character_id,i.user.id);

        const shares = unwrap(await db.from("vehicle_access")
          .select("id,character_id,characters(name)")
          .eq("vehicle_id",vehicleId)
          .eq("status","active")
          .limit(25),"vehicle active shares");

        if (!shares?.length) return respond(i,{content:"This vehicle isn't shared with anyone."});

        return respond(i,{
          content:"Choose a shared character to manage:",
          components:[selectRow(`vehicle_share_manage_pick:${vehicleId}`,"Choose character",shares.map(s=>({
            label:s.characters?.name || "Character",
            description:"Full shared access",
            value:s.id
          })))]
        });
      }

      if (id === "vehicle_transfer_owner") {
        const vehicleId = arg;
        const vehicle = unwrap(await db.from("vehicles").select("id,character_id,name").eq("id",vehicleId).limit(1),"vehicle transfer")?.[0];
        await ensureOwnedCharacter(vehicle.character_id,i.user.id);
        return respond(i,{
          content:`Who should become the new owner of **${vehicle.name}**?`,
          components:[userSelectRow(`vehicle_transfer_user:${vehicleId}`,"Choose user")]
        });
      }

      if (id === "vehicle_share") {
        const vehicleId = arg;
        const vehicle = unwrap(await db.from("vehicles").select("id,character_id,name").eq("id",vehicleId).limit(1),"vehicle share")?.[0];
        const owner = await ensureOwnedCharacter(vehicle.character_id,i.user.id);
        return respond(i,{
          content:`Who do you want **${owner.name}** to share **${vehicle.name}** with?`,
          components:[userSelectRow(`vehicle_share_user:${vehicleId}`,"Choose Discord user")]
        });
      }


      if (id === "vehicle_unshare") {
        const accessId = arg;
        const access = unwrap(await db.from("vehicle_access")
          .select("id,vehicle_id,vehicles(character_id)")
          .eq("id",accessId).limit(1),"vehicle access")?.[0];
        if (!access) throw new Error("Shared vehicle access not found.");
        await ensureOwnedCharacter(access.vehicles.character_id,i.user.id);
        unwrap(await db.from("vehicle_access").update({status:"removed"}).eq("id",accessId),"remove vehicle access");
        return respond(i,{content:"✅ Vehicle sharing access removed."});
      }


      if (id === "property_move_out") {
        const parts = i.customId.split(":");
        const propertyId = parts[1];
        const characterId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        return respond(i,{
          content:`Move **${c.name}** out of this property? This ends their lease/residency and releases the unit when appropriate.`,
          components:[buttonRow([
            {id:`property_move_out_confirm:${propertyId}:${c.id}`,label:"Confirm Move Out",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "property_move_out_confirm") {
        const parts = i.customId.split(":");
        const propertyId = parts[1];
        const characterId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        const result = unwrap(await db.rpc("move_out_character",{
          p_property_id:propertyId,
          p_character_id:c.id,
          p_discord_user_id:i.user.id
        }),"move out");
        const r = Array.isArray(result) ? result[0] : result;

        return respond(i,{content:`✅ **${c.name}** moved out.${r?.released_unit ? " The unit is available again." : ""}`});
      }

      if (id === "property_split_start") {
        const contract = unwrap(await db.from("property_contracts")
          .select("id,property_id,character_id,share_voro,status,properties(name,monthly_cost_voro)")
          .eq("id",arg).limit(1),"split contract")?.[0];
        if (!contract) throw new Error("Housing contract not found.");
        await ensureOwnedCharacter(contract.character_id,i.user.id);

        return respond(i,{
          content:`Choose a Discord user to add as a payer for **${contract.properties?.name || "this property"}**:`,
          components:[userSelectRow(`property_split_user:${contract.id}`,"Choose payer")]
        });
      }

      if (id === "property_split_accept") {
        const splitMemberId = arg;
        const member = unwrap(await db.from("property_split_payers")
          .select("id,character_id,discord_user_id,status,split_group_id,share_voro")
          .eq("id",splitMemberId).limit(1),"split payer")?.[0];
        if (!member || member.discord_user_id !== i.user.id) throw new Error("This split-payment request is not for you.");

        const payer = await characterById(member.character_id);
        const group = unwrap(await db.from("property_split_groups")
          .select("id,primary_character_id,property_id,properties(name)")
          .eq("id",member.split_group_id).limit(1),"split group")?.[0];
        const primary = group ? await characterById(group.primary_character_id) : null;

        unwrap(await db.from("property_split_payers")
          .update({status:"accepted",accepted_at:new Date().toISOString()})
          .eq("id",splitMemberId),"accept split payment");

        const splitStatus = unwrap(await db.rpc("refresh_property_split_status",{p_split_group_id:member.split_group_id}),"refresh split");

        if (primary?.owner_discord_id) {
          try {
            const ownerUser = await client.users.fetch(primary.owner_discord_id);
            await ownerUser.send({
              embeds:[new EmbedBuilder()
                .setTitle("✅ Housing Split Accepted")
                .setDescription(`**${payer?.name || "The invited payer"}** accepted the split-payment request for **${group?.properties?.name || "the property"}**.`)
                .addFields({name:"Their Share",value:nova(member.share_voro),inline:true})
                .setFooter({text:splitStatus === "active" ? "All required split payers have accepted." : "John may still be waiting on other payers."})]
            });
          } catch (e) {
            console.warn("[Housing split accept owner notification failed]",e.message);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🏠 Split Payment Accepted")
            .setDescription(`You accepted your **${nova(member.share_voro)}** share for **${group?.properties?.name || "the property"}**.`)]
        });
      }

      if (id === "property_split_decline") {
        const splitMemberId = arg;
        const member = unwrap(await db.from("property_split_payers")
          .select("id,character_id,discord_user_id,split_group_id,share_voro")
          .eq("id",splitMemberId).limit(1),"split payer")?.[0];
        if (!member || member.discord_user_id !== i.user.id) throw new Error("This split-payment request is not for you.");

        const payer = await characterById(member.character_id);
        const group = unwrap(await db.from("property_split_groups")
          .select("id,primary_character_id,property_id,properties(name)")
          .eq("id",member.split_group_id).limit(1),"split group")?.[0];
        const primary = group ? await characterById(group.primary_character_id) : null;

        unwrap(await db.from("property_split_payers")
          .update({status:"declined"})
          .eq("id",splitMemberId),"decline split payment");
        unwrap(await db.from("property_split_groups")
          .update({status:"declined"})
          .eq("id",member.split_group_id),"decline split group");

        if (primary?.owner_discord_id) {
          try {
            const ownerUser = await client.users.fetch(primary.owner_discord_id);
            await ownerUser.send({
              embeds:[new EmbedBuilder()
                .setTitle("❌ Housing Split Declined")
                .setDescription(`**${payer?.name || "The invited payer"}** declined the split-payment request for **${group?.properties?.name || "the property"}**.`)
                .setFooter({text:"The split arrangement will not activate."})]
            });
          } catch (e) {
            console.warn("[Housing split decline owner notification failed]",e.message);
          }
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("Split Payment Declined")
            .setDescription(`You declined the split-payment request for **${group?.properties?.name || "the property"}**.`)]
        });
      }

      if (id === "property_reserve") {
        const propertyId = arg;
        const characterId = i.customId.split(":")[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);
        await requireChecking(c.id);

        const result = unwrap(await db.rpc("reserve_property_unit",{
          p_property_id:propertyId,
          p_character_id:c.id,
          p_discord_user_id:i.user.id
        }),"reserve property");

        const reservation = Array.isArray(result) ? result[0] : result;
        if (!reservation?.contract_id) throw new Error("John couldn't reserve that property.");

        const property = unwrap(await db.from("properties").select("*").eq("id",propertyId).limit(1),"reserved property")?.[0];

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("📝 Housing Contract")
            .setDescription(`**${c.name}** is reserving **${property.name}**${reservation.unit_number ? ` — Unit ${reservation.unit_number}` : ""}.`)
            .addFields(
              {name:"Monthly Cost",value:nova(property.monthly_cost_voro),inline:true},
              {name:"Payment Source",value:"Equity Financial Checking",inline:true},
              {name:"Authorization",value:"Accepting authorizes John to use this character's Checking account for scheduled housing payments."}
            )],
          components:[buttonRow([
            {id:`property_contract_accept:${reservation.contract_id}`,label:"Accept Contract",style:ButtonStyle.Success},
            {id:`property_split_start:${reservation.contract_id}`,label:"Split Payment",style:ButtonStyle.Primary},
            {id:`property_contract_decline:${reservation.contract_id}`,label:"Decline",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "property_contract_accept") {
        const contractId = arg;
        const result = unwrap(await db.rpc("accept_property_contract",{
          p_contract_id:contractId,
          p_discord_user_id:i.user.id
        }),"accept property contract");

        const accepted = Array.isArray(result) ? result[0] : result;
        const contractInfo = unwrap(await db.from("property_contracts")
          .select("property_id,character_id,properties(name)")
          .eq("id",contractId).limit(1),"accepted property info")?.[0];
        const resident = contractInfo ? await characterById(contractInfo.character_id) : null;

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🎉 Congratulations — Housing Secured!")
            .setDescription(`**${resident?.name || "Your character"}** now has **${contractInfo?.properties?.name || "the property"}**.${accepted?.unit_number ? `\nAssigned unit: **${accepted.unit_number}**.` : ""}`)
            .setFooter({text:"The housing contract is active."})]
        });
      }

      if (id === "property_contract_decline") {
        const contractId = arg;
        unwrap(await db.rpc("decline_property_contract",{
          p_contract_id:contractId,
          p_discord_user_id:i.user.id
        }),"decline property contract");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("Housing Contract Declined")
            .setDescription("You declined the housing contract. The unit/property has been released and is available again.")]
        });
      }

      if (id === "property_adjust_units") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");
        const propertyId = arg;
        const property = unwrap(await db.from("properties").select("id,name,total_units,occupied_units,reserved_units").eq("id",propertyId).limit(1),"adjust property units")?.[0];
        if (!property) throw new Error("Property not found.");

        return i.showModal(modal(`property_adjust_units_modal:${propertyId}`,"Adjust Unit Count",[
          {id:"units",label:"Total Units",value:String(property.total_units || 1),placeholder:"12"}
        ]));
      }

      if (id === "bank_open_checking") {
        await ensureOwnedCharacter(arg,i.user.id);
        unwrap(await db.rpc("open_checking_account",{p_character_id:arg}),"open checking");
        return respond(i, {content:`✅ **${BANK_NAME} Checking opened.** Your starter Nova has been deposited.`});
      }

      if (id === "bank_open_savings") {
        await ensureOwnedCharacter(arg,i.user.id);
        unwrap(await db.rpc("open_savings_account",{p_character_id:arg}),"open savings");
        return respond(i, {content:`✅ **${BANK_NAME} Savings opened.**`});
      }


      if (id === "bank_transfer") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        const accounts = await transferableAccountsFor(c.id);

        if (accounts.length < 2) {
          throw new Error("You need at least two accessible Equity Financial accounts to make an account transfer.");
        }

        return respond(i,{
          content:"Which account should the Nova come **from**?",
          components:[selectRow(`bank_transfer_from:${c.id}`,"Transfer from",accounts.slice(0,25).map(a=>({
            label:a.label.slice(0,100),
            description:`Available: ${nova(a.balance_voro)}`.slice(0,100),
            value:a.id
          })))]
        });
      }



      if (id === "bank_deposit") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        const accounts = await transferableAccountsFor(c.id);
        if (!accounts.length) throw new Error("Open an Equity Financial account first.");
        if (Number(c.cash_voro || 0) <= 0) throw new Error("This character has no cash available to deposit.");

        return respond(i,{
          content:`**${c.name}** has ${nova(c.cash_voro)} in cash. Which account should receive the deposit?`,
          components:[selectRow(`bank_deposit_pick:${c.id}`,"Deposit into",accounts.slice(0,25).map(a=>({
            label:a.label.slice(0,100),
            description:`Current balance: ${nova(a.balance_voro)}`.slice(0,100),
            value:a.id
          })))]
        });
      }

      if (id === "bank_manage_accounts") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        const accounts = await transferableAccountsFor(c.id);
        if (!accounts.length) throw new Error("This character has no manageable bank accounts.");

        return respond(i,{
          content:"Choose an account to manage:",
          components:[selectRow(`bank_manage_pick:${c.id}`,"Choose account",accounts.slice(0,25).map(a=>({
            label:a.label.slice(0,100),
            description:`${nova(a.balance_voro)}`.slice(0,100),
            value:a.id
          })))]
        });
      }

      if (id === "bank_cashout") {
        const c = await ensureOwnedCharacter(arg,i.user.id);
        const accounts = await transferableAccountsFor(c.id);

        const cashable = accounts.filter(a => Number(a.balance_voro || 0) > 0);
        if (!cashable.length) {
          throw new Error("There is no Nova available to cash out from this character's accessible accounts.");
        }

        return respond(i,{
          content:"Which account do you want to cash out?",
          components:[selectRow(`bank_cashout_pick:${c.id}`,"Choose account",cashable.slice(0,25).map(a=>({
            label:a.label.slice(0,100),
            description:`Cash out ${nova(a.balance_voro)}`.slice(0,100),
            value:a.id
          })))]
        });
      }

      if (id === "bank_transactions") {
        const c = await ensureOwnedCharacter(arg,i.user.id);

        // PRIVATE BANK HISTORY:
        // Only personal accounts owned by this active character are included here.
        // Joint-account activity is intentionally kept out of this private history.
        const accounts = unwrap(await db.from("bank_accounts")
          .select("id")
          .eq("character_id",c.id)
          .in("account_type",["checking","savings"])
          .eq("status","active"),"private bank account ids") || [];

        const ids = accounts.map(a=>a.id);

        const rows = ids.length
          ? unwrap(await db.from("transactions")
              .select("*")
              .eq("character_id",c.id)
              .in("account_id",ids)
              .order("created_at",{ascending:false})
              .limit(10),"private character transactions")
          : [];

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🏦 ${BANK_NAME} — ${c.name}'s Recent Transactions`)
            .setDescription(rows?.length
              ? rows.map(t=>`**${nova(t.amount_voro)}** • ${t.transaction_type || "Transaction"} • <t:${Math.floor(new Date(t.created_at).getTime()/1000)}:R>`).join("\n")
              : "No transactions yet.")
            .setFooter({text:"Private history for this active character only."})]
        });
      }


      if (id === "business_bulk_add") {
        const businessId=arg;
        const business=await ensureBusinessOwnerOrModerator(i,businessId);
        return i.showModal(modal(
          `business_quick_add_modal:${businessId}`,
          `Quick Add — ${business.name}`,
          [
            {id:"category",label:"Category for this batch",required:false,placeholder:"Appetizers, Drinks, Services..."},
            {id:"items",label:"Paste menu items — one per line",long:true,
             placeholder:"Mozzarella Sticks | 12.00 | Crispy with marinara\nWings | 15.00 | Choice of sauce\nOR: Latte | 6.00 | Drinks | Vanilla latte"}
          ]
        ));
      }


      if (id === "business_view_catalog") {
        const businessId = arg;

        const business = await ensureBusinessOwnerOrModerator(i,businessId);

        const items = unwrap(await db.from("business_items")
          .select("id,item_name,price_voro,category,description,is_active")
          .eq("business_id",businessId)
          .order("category",{ascending:true})
          .order("item_name",{ascending:true})
          .limit(25),"view catalog items");

        const preview = formatBusinessMenu(items || []);
        const menuEmbed = new EmbedBuilder()
          .setTitle(`${business.business_type === "restaurant" ? "🍽️" : "🛍️"} ${business.name}`)
          .setDescription(`${business.business_type === "restaurant" ? "*MENU*" : "*CATALOG*"}\n\n${preview}\n\n────────────\n*Select or manage items below.*`);

        if (business.logo_url) menuEmbed.setThumbnail(business.logo_url);

        return respond(i,{
          embeds:[menuEmbed],
          components:[buttonRow([
            {id:`business_bulk_add:${businessId}`,label:"Quick Add More",style:ButtonStyle.Success},
            {id:`business_upload_logo:${businessId}`,label:"Upload Logo"}
          ])]
        });
      }

      if (id === "business_next_item") {
        const businessId=arg;
        const business=await ensureBusinessOwnerOrModerator(i,businessId);
        return i.showModal(modal(
          `business_quick_add_modal:${businessId}`,
          `Quick Add — ${business.name}`,
          [
            {id:"category",label:"Category for this batch",required:false,placeholder:"Appetizers, Drinks, Services..."},
            {id:"items",label:"Paste menu items — one per line",long:true,
             placeholder:"Name | 12.00 | Description\nOR: Name | 12.00 | Category | Description"}
          ]
        ));
      }


      if (id === "business_edit_item_pick") {
        const businessId = arg;
        const items = unwrap(await db.from("business_items")
          .select("id,item_name,price_voro,category,description")
          .eq("business_id",businessId)
          .eq("is_active",true)
          .order("category")
          .limit(25),"business edit items");
        if (!items?.length) throw new Error("This business has no active items.");

        return respond(i,{
          content:"Choose an item to edit:",
          components:[selectRow(`business_edit_item:${businessId}`,"Choose item",items.map(x=>({
            label:x.item_name.slice(0,100),
            description:`${nova(x.price_voro)}${x.category ? ` • ${x.category}` : ""}`.slice(0,100),
            value:x.id
          })))]
        });
      }

      if (id === "business_remove_item_pick") {
        const businessId = arg;
        const items = unwrap(await db.from("business_items")
          .select("id,item_name,price_voro,category")
          .eq("business_id",businessId)
          .eq("is_active",true)
          .order("category")
          .limit(25),"business remove items");
        if (!items?.length) throw new Error("This business has no active items.");

        return respond(i,{
          content:"Choose an item to remove:",
          components:[selectRow(`business_remove_item:${businessId}`,"Choose item",items.map(x=>({
            label:x.item_name.slice(0,100),
            description:`${nova(x.price_voro)}${x.category ? ` • ${x.category}` : ""}`.slice(0,100),
            value:x.id
          })))]
        });
      }

      if (id === "business_upload_logo") {
        const businessId = arg;

        // ACK the logo button immediately before any Supabase lookup.
        // Otherwise Discord can expire the interaction while ownership is checked.
        if (!i.deferred && !i.replied) {
          try {
            await i.deferUpdate();
            console.log(`[LOGO FAST ACK] ${businessId} ${i.id}`);
          } catch (error) {
            if (error?.code === 10062 || error?.code === 40060) {
              console.warn(`[LOGO ACK FAILED] ${error.code} ${i.id}`);
              return;
            }
            throw error;
          }
        }

        const business = await ensureBusinessOwnerOrModerator(i,businessId);

        await respond(i,{
          content:`🖼️ **Upload the logo for ${business.name}.**\nSend one image attachment in this channel within 2 minutes.`,
          components:[]
        });

        const filter = m =>
          m.author.id === i.user.id &&
          m.channel.id === i.channelId &&
          m.attachments.size > 0;

        try {
          const collected = await i.channel.awaitMessages({
            filter,
            max:1,
            time:120000,
            errors:["time"]
          });

          const msg = collected.first();
          const attachment = msg.attachments.first();

          if (!attachment?.contentType?.startsWith("image/")) {
            return i.followUp({content:"⚠️ That attachment is not an image. Click **Upload Logo** and try again.", ephemeral:true});
          }

          unwrap(await db.from("businesses")
            .update({logo_url:attachment.url})
            .eq("id",businessId),"save business logo");

          return i.followUp({
            content:`✅ Logo saved for **${business.name}**.`,
            files:[attachment.url]
          });
        } catch {
          return i.followUp({
            content:"⌛ Logo upload timed out. Click **Upload Logo** whenever you're ready to try again.",
            ephemeral:true
          });
        }
      }

      if (id === "manage_remove_confirm") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");
        const parts = i.customId.split(":");
        const kind = parts[1];
        const itemId = parts[2];
        if(kind==="businesses") {
          throw new Error("Businesses must be deleted through the typed-name confirmation flow.");
        }
        const tableMap = {jobs:"jobs",properties:"properties",vehicles:"vehicles",subscriptions:"subscriptions",characters:"characters"};
        const table = tableMap[kind];
        if (!table) throw new Error("Unknown management category.");
        unwrap(await db.from(table).delete().eq("id",itemId),`remove ${kind}`);
        unwrap(await db.from("admin_audit_logs").insert({
          guild_id:i.guildId,
          moderator_discord_id:i.user.id,
          action_type:`remove_${kind}`,
          details:{id:itemId}
        }),"audit remove");
        return respond(i,{content:`✅ ${kind.slice(0,-1)} removed.`});
      }

      if (id === "admin_settings_edit") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");
        return i.showModal(modal("admin_settings_modal","Economy Settings",[
          {id:"starter",label:"Starter Nova",placeholder:"1000.00"},
          {id:"tax",label:"NABIT Tax Percent",placeholder:"9"},
          {id:"overdraft",label:"Allow Overdraft? yes/no",placeholder:"no"}
        ]));
      }
    }


    if (i.isUserSelectMenu()) {
      const isPersonalShareFlow =
        i.customId.startsWith("joint_user:") ||
        i.customId.startsWith("vehicle_share_user:") ||
        i.customId.startsWith("property_split_user:") ||
        i.customId.startsWith("shop_gift_user:") ||
        i.customId.startsWith("shop_cart_gift_user:") ||
        i.customId.startsWith("inventory_give_user:") ||
        i.customId.startsWith("beu:");

      if (!isPersonalShareFlow && !i.memberPermissions?.has("Administrator")) {
        throw new Error("Administrator permission required.");
      }

      const targetUserId = i.values[0];

      if (i.customId.startsWith("beu:")) {
        const businessId=i.customId.split(":")[1];
        const access=await businessManagementAccess(i,businessId,{ownerOnly:true});
        if(!i.deferred && !i.replied) await i.deferUpdate();

        const chars=await charactersFor(targetUserId);
        if(!chars?.length) return respond(i,{content:"That Discord user has no John characters."});

        return respond(i,{
          content:`Which character should receive the job offer from **${access.business.name}**?`,
          components:[selectRow(`bec:${businessId}:${targetUserId}`,"Choose character",chars.slice(0,25).map(c=>({
            label:c.name.slice(0,100),
            value:c.id
          })))]
        });
      }



      if (i.customId.startsWith("shop_cart_gift_user:")) {
        const cartToken = i.customId.split(":")[1];
        const cart = getShopCart(cartToken);
        await ensureOwnedCharacter(cart.buyerCharacterId,i.user.id);

        const chars = await charactersFor(targetUserId);
        if (!chars?.length) return respond(i,{content:"That Discord user has no John characters."});

        const nextToken = makeShopCart({...cart,targetUserId});
        shopCarts.delete(cartToken);

        return respond(i,{
          content:"Which character should receive the entire order?",
          components:[selectRow(`shop_cart_gift_character:${nextToken}`,"Choose recipient character",chars.map(c=>({
            label:c.name,
            value:c.id
          })))]
        });
      }


      if (i.customId.startsWith("shop_gift_user:")) {
        const token = i.customId.split(":")[1];
        const action = getShopToken(token);
        await ensureOwnedCharacter(action.buyerCharacterId,i.user.id);

        const chars = await charactersFor(targetUserId);
        if (!chars?.length) return respond(i,{content:"That Discord user has no John characters."});

        const nextToken = makeShopToken({...action,targetUserId});
        return respond(i,{
          content:"Which character should receive the gift?",
          components:[selectRow(`shop_gift_character:${nextToken}`,"Choose recipient character",chars.map(c=>({label:c.name,value:c.id})))]
        });
      }

      if (i.customId.startsWith("inventory_give_user:")) {
        const inventoryId=i.customId.split(":")[1];
        const c=await currentCharacter(i);

        const item=unwrap(await db.from("character_inventory")
          .select("id,character_id,item_name,is_active")
          .eq("id",inventoryId).eq("character_id",c.id).eq("is_active",true)
          .limit(1),"inventory give user item")?.[0];
        if(!item) throw new Error("That inventory item is no longer available.");

        const chars=await charactersFor(targetUserId);
        if(!chars?.length) return respond(i,{content:"That Discord user has no John characters."});

        return respond(i,{
          content:`Which character should receive **${item.item_name}**?`,
          components:[selectRow(`inventory_give_character:${inventoryId}:${targetUserId}`,
            "Choose recipient character",chars.slice(0,25).map(c=>({label:c.name,value:c.id})))]
        });
      }

      if (i.customId.startsWith("joint_user:")) {
        const ownerCharacterId = i.customId.split(":")[1];
        await ensureOwnedCharacter(ownerCharacterId,i.user.id);
        const chars = await charactersFor(targetUserId);
        if (!chars?.length) return respond(i,{content:"That Discord user has no John characters."});
        return respond(i,{
          content:"Which character should be the joint account holder?",
          components:[selectRow(`joint_character:${ownerCharacterId}:${targetUserId}`,"Choose character",chars.map(c=>({label:c.name,value:c.id})))]
        });
      }

      if (i.customId.startsWith("vehicle_share_user:")) {
        const vehicleId = i.customId.split(":")[1];
        const vehicle = unwrap(await db.from("vehicles").select("id,character_id,name").eq("id",vehicleId).limit(1),"vehicle owner check")?.[0];
        await ensureOwnedCharacter(vehicle.character_id,i.user.id);
        const chars = await charactersFor(targetUserId);
        if (!chars?.length) return respond(i,{content:"That Discord user has no John characters."});
        return respond(i,{
          content:`Choose which character can use **${vehicle.name}**:`,
          components:[selectRow(`vehicle_share_character:${vehicleId}:${targetUserId}`,"Choose character",chars.map(c=>({label:c.name,value:c.id})))]
        });
      }

      if (i.customId.startsWith("property_split_user:")) {
        const contractId = i.customId.split(":")[1];
        const contract = unwrap(await db.from("property_contracts").select("id,character_id").eq("id",contractId).limit(1),"split owner")?.[0];
        await ensureOwnedCharacter(contract.character_id,i.user.id);
        const chars = await charactersFor(targetUserId);
        if (!chars?.length) return respond(i,{content:"That Discord user has no John characters."});
        return respond(i,{
          content:"Choose which character will share the housing payment:",
          components:[selectRow(`property_split_character:${contractId}:${targetUserId}`,"Choose payer character",chars.map(c=>({label:c.name,value:c.id})))]
        });
      }


      if (i.customId === "create_job_user" ||
          i.customId === "create_vehicle_user" ||
          i.customId === "create_property_user" ||
          i.customId === "create_subscription_user" ||
          i.customId === "create_business_owner_user") {

        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const chars = await charactersFor(targetUserId);
        if (!chars?.length) {
          return respond(i,{content:"That Discord user does not have any John characters yet."});
        }

        const kind = i.customId
          .replace("create_","")
          .replace("_owner_user","")
          .replace("_user","");

        return respond(i,{
          content:"Choose the character:",
          components:[selectRow(
            `create_target_character:${kind}:${targetUserId}`,
            "Choose character",
            chars.map(c=>({label:c.name,value:c.id}))
          )]
        });
      }

      if (i.customId === "admin_assign_job_user") {
        const chars = await charactersFor(targetUserId);
        if (!chars?.length) {
          return respond(i,{content:"That Discord user does not have any John characters yet."});
        }

        return respond(i,{
          content:"Choose which character gets the job:",
          components:[selectRow(
            `admin_assign_job_character:${targetUserId}`,
            "Choose character",
            chars.map(c=>({label:c.name,value:c.id}))
          )]
        });
      }

      if (i.customId === "admin_end_job_user") {
        const chars = await charactersFor(targetUserId);
        if (!chars?.length) {
          return respond(i,{content:"That Discord user does not have any John characters yet."});
        }

        return respond(i,{
          content:"Choose the character:",
          components:[selectRow(
            `admin_end_job_character:${targetUserId}`,
            "Choose character",
            chars.map(c=>({label:c.name,value:c.id}))
          )]
        });
      }
    }

    if (i.isStringSelectMenu()) {
      const [id,arg1,arg2] = i.customId.split(":");
      const value = i.values[0];
      console.log(`[SELECT] ${i.customId} -> ${value} by ${i.user.id}`);










      if (id === "bec") {
        const businessId=arg1;
        const targetUserId=arg2;
        const characterId=value;

        // Open the form immediately; ownership/permissions and character ownership
        // are validated again when the offer is submitted.
        return i.showModal(modal(`beom:${businessId}:${targetUserId}:${characterId}`,"Add Employee",[
          {id:"position",label:"Position",placeholder:"Barista"},
          {id:"pay",label:"Pay in Nova",placeholder:"18.00"},
          {id:"pay_type",label:"Pay Type",placeholder:"hourly or salary"},
          {id:"schedule",label:"Work Schedule",required:false,placeholder:"Mon-Fri, 8 AM-2 PM"},
          {id:"role",label:"Role",placeholder:"employee or manager",value:"employee"}
        ]));
      }

      if (id === "bepick") {
        const businessId=arg1;
        const jobId=value;
        const access=await businessManagementAccess(i,businessId);
        const job=unwrap(await db.from("jobs")
          .select("id,position,pay_type,pay_amount_voro,status,employment_role,work_schedule,characters(name)")
          .eq("id",jobId).eq("business_id",businessId).limit(1),"employee details")?.[0];
        if(!job) throw new Error("Employee job not found.");

        const role=job.employment_role || "employee";
        const buttons=[
          {id:`bee:${businessId}:${jobId}`,label:"Edit Position / Pay",style:ButtonStyle.Primary}
        ];

        if(access.role!=="manager") {
          if(role==="manager") buttons.push({id:`bedem:${businessId}:${jobId}`,label:"Demote to Employee"});
          else buttons.push({id:`beprom:${businessId}:${jobId}`,label:"Promote to Manager",style:ButtonStyle.Success});
          buttons.push({id:`bef:${businessId}:${jobId}`,label:"Fire",style:ButtonStyle.Danger});
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`👤 ${job.characters?.name || "Employee"}`)
            .setDescription(`**${job.position}**`)
            .addFields(
              {name:"Pay",value:`${nova(job.pay_amount_voro)} • ${job.pay_type}`,inline:true},
              {name:"Role",value:role==="manager"?"Manager":"Employee",inline:true},
              {name:"Status",value:job.status,inline:true},
              {name:"Schedule",value:job.work_schedule || "Not specified"}
            )],
          components:buttons.length?[buttonRow(buttons.slice(0,5))]:[]
        });
      }

      if (id === "business_manage_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const business = unwrap(await db.from("businesses")
          .select("id,name,business_type,owner_character_id,status")
          .eq("id",value)
          .limit(1),"business manage pick")?.[0];

        if (!business) throw new Error("Business not found.");
        if (!isModerator(i) && business.owner_character_id !== c.id) throw new Error("You do not own that business.");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🏪 ${business.name}`)
            .setDescription(`Manage this ${business.business_type === "restaurant" ? "restaurant" : "shop"} below.`)],
          components:[selectRow(`business_manage_action:${c.id}:${business.id}`,"Choose an option",[
            {label:"View / Manage Menu",value:"menu"},
            {label:"Quick Add Menu Items",value:"quick_add"},
            {label:"Add One Item",value:"add_one"},
            {label:"Edit Menu Item",value:"edit"},
            {label:"Remove Menu Item",value:"remove"},
            {label:"Upload / Change Logo",value:"logo"},
            {label:"Owner Pay / Salary",value:"owner_pay"}
          ])]
        });
      }

      if (id === "business_manage_action") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const businessId = arg2;
        const business = unwrap(await db.from("businesses")
          .select("id,name,owner_character_id")
          .eq("id",businessId).limit(1),"business manage action")?.[0];

        if (!business) throw new Error("Business not found.");
        if (!isModerator(i) && business.owner_character_id !== c.id) throw new Error("You do not own that business.");

        if (value === "menu") {
          const items = unwrap(await db.from("business_items")
            .select("id,item_name,price_voro,category,description,is_active")
            .eq("business_id",businessId)
            .order("category",{ascending:true})
            .order("item_name",{ascending:true})
            .limit(25),"business menu preview") || [];

          const b = unwrap(await db.from("businesses")
            .select("id,name,business_type,logo_url")
            .eq("id",businessId).limit(1),"business menu business")?.[0];

          const preview = formatBusinessMenu(items);
          const embed = new EmbedBuilder()
            .setTitle(`${b.business_type === "restaurant" ? "🍽️" : "🛍️"} ${b.name}`)
            .setDescription(`${b.business_type === "restaurant" ? "*MENU*" : "*CATALOG*"}\n\n${preview}\n\n────────────\n*Manage this menu below.*`);
          if (b.logo_url) embed.setThumbnail(b.logo_url);

          return respond(i,{
            embeds:[embed],
            components:[
              buttonRow([
                {id:`business_bulk_add:${businessId}`,label:"Quick Add Menu",style:ButtonStyle.Success},
                {id:`business_edit_page:${businessId}:0`,label:"Edit Item"},
                {id:`business_remove_page:${businessId}:0`,label:"Remove Item",style:ButtonStyle.Danger},
                {id:`business_upload_logo:${businessId}`,label:"Upload Logo"}
              ])
            ]
          });
        }

        if (value === "quick_add") {
          const business=await ensureBusinessOwnerOrModerator(i,businessId);
          return i.showModal(modal(
            `business_quick_add_modal:${businessId}`,
            `Quick Add — ${business.name}`,
            [
              {id:"category",label:"Category for this batch",required:false,placeholder:"Appetizers, Drinks, Services..."},
              {id:"items",label:"Paste menu items — one per line",long:true,
               placeholder:"Mozzarella Sticks | 12.00 | Crispy with marinara\nWings | 15.00 | Choice of sauce\nOR: Latte | 6.00 | Drinks | Vanilla latte"}
            ]
          ));
        }

        if (value === "add_one") {
          const business = unwrap(await db.from("businesses")
            .select("id,name,business_type")
            .eq("id",businessId)
            .limit(1),"add one business")?.[0];
          if (!business) throw new Error("Business not found.");

          return i.showModal(modal(
            `business_add_item_single_modal:${businessId}`,
            `Add Item — ${business.name}`,
            [
              {id:"name",label:"Item Name",placeholder:"Mozzarella Sticks"},
              {id:"price",label:"Price in Nova",placeholder:"12.00"},
              {id:"category",label:"Category",placeholder:"Appetizers"},
              {id:"description",label:"Description",long:true,required:false,placeholder:"Short item or food description"}
            ]
          ));
        }

        if (value === "owner_pay") {
          const b = unwrap(await db.from("businesses")
            .select("id,name,owner_character_id")
            .eq("id",businessId).limit(1),"owner pay business")?.[0];
          if (!b) throw new Error("Business not found.");
          if (!isModerator(i) && b.owner_character_id !== c.id) throw new Error("Only the business owner can manage owner pay.");

          const businessAccount = await businessAccountFor(businessId);
          const salary = unwrap(await db.from("business_owner_compensation")
            .select("salary_voro,schedule,status,next_pay_at")
            .eq("business_id",businessId)
            .eq("owner_character_id",b.owner_character_id)
            .limit(1),"owner salary settings")?.[0];

          const salaryText = salary?.status === "active"
            ? `${nova(salary.salary_voro)} • ${salary.schedule} • next <t:${Math.floor(new Date(salary.next_pay_at).getTime()/1000)}:R>`
            : "Not active";

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle(`💼 Owner Pay — ${b.name}`)
              .setDescription(`Business balance: **${nova(businessAccount?.balance_voro || 0)}**`)
              .addFields(
                {name:"Owner Salary",value:salaryText},
                {name:"Owner Draw",value:"Manual one-time transfer from the business account to the owner's personal Checking."}
              )],
            components:[
              buttonRow([
                {id:`business_owner_draw:${businessId}`,label:"Owner Draw",style:ButtonStyle.Success},
                {id:`business_owner_salary:${businessId}`,label:"Set / Edit Salary",style:ButtonStyle.Primary},
                {id:`business_owner_salary_off:${businessId}`,label:"Turn Salary Off",style:ButtonStyle.Danger}
              ])
            ]
          });
        }

        if (value === "edit") return await businessItemManagePage(i,businessId,"edit",0);
        if (value === "remove") return await businessItemManagePage(i,businessId,"remove",0);
        if (value === "logo") return respond(i,{content:"Upload/change the logo:",components:[
          buttonRow([{id:`business_upload_logo:${businessId}`,label:"Upload Logo"}])
        ]});
      }

      if (id === "business_edit_item") {
        const businessId = arg1;
        const item = unwrap(await db.from("business_items")
          .select("id,item_name,price_voro,category,description")
          .eq("id",value).eq("business_id",businessId).limit(1),"edit business item")?.[0];
        if (!item) throw new Error("Item not found.");

        return i.showModal(modal(`business_edit_item_modal:${item.id}`,"Edit Business Item",[
          {id:"name",label:"Item Name",value:item.item_name},
          {id:"price",label:"Price",value:(Number(item.price_voro)/100).toFixed(2)},
          {id:"category",label:"Category",value:item.category || ""},
          {id:"description",label:"Description",long:true,required:false,value:item.description || ""}
        ]));
      }

      if (id === "business_remove_item") {
        unwrap(await db.from("business_items")
          .update({is_active:false})
          .eq("id",value)
          .eq("business_id",arg1),"remove business item");
        return respond(i,{content:"✅ Item removed from the active menu/catalog."});
      }



      if (id === "shop_cart_quantity_item") {
        const cart = getShopCart(arg1);
        await ensureOwnedCharacter(cart.buyerCharacterId,i.user.id);

        const itemIndex = Number(value);
        const item = cart.items[itemIndex];
        if (!item) throw new Error("Cart item not found.");

        return i.showModal(modal(
          `shop_cart_quantity_modal:${arg1}:${itemIndex}`,
          `Quantity — ${item.item_name}`,
          [
            {id:"quantity",label:"How many?",placeholder:"2",value:String(item.quantity || 1)}
          ]
        ));
      }

      if (id === "shop_cart_gift_character") {
        const cart = getShopCart(arg1);
        const buyer = await ensureOwnedCharacter(cart.buyerCharacterId,i.user.id);
        const recipient = await characterById(value);

        if (!recipient || recipient.owner_discord_id !== cart.targetUserId) {
          throw new Error("Recipient character mismatch.");
        }

        const result = unwrap(await db.rpc("purchase_business_items",{
          p_business_id:cart.businessId,
          p_item_ids:cart.items.map(x=>x.id),
          p_quantities:cart.items.map(x=>Number(x.quantity||1)),
          p_buyer_character_id:buyer.id,
          p_discord_user_id:i.user.id,
          p_recipient_character_id:recipient.id,
          p_is_gift:true
        }),"gift business items");
        const r = Array.isArray(result)?result[0]:result;

        shopCarts.delete(arg1);

        await sendJohnNotification({
          i,
          type:"shop_gift",
          payload:{
            embeds:[new EmbedBuilder()
              .setTitle("🎁 Gift Order")
              .setDescription(`**${buyer.name}** bought **${recipient.name}** **${r.item_count_out} item${Number(r.item_count_out)===1?"":"s"}** from **${cart.businessName}** for **${nova(r.total_voro_out)}**.`)]
          }
        });

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🎁 Gift Order Complete")
            .setDescription(`**${buyer.name}** bought **${r.item_count_out} item${Number(r.item_count_out)===1?"":"s"}** from **${cart.businessName}** for **${recipient.name}**.\n\n**Total:** ${nova(r.total_voro_out)}\nThe order was added to **${recipient.name}'s Inventory**.`)
            .addFields({name:"Buyer's Checking Balance",value:nova(r.balance_after_voro_out),inline:true})]
        });
      }


      if (id === "shop_gift_character") {
        const action = getShopToken(arg1);
        const buyer = await ensureOwnedCharacter(action.buyerCharacterId,i.user.id);
        const recipient = await characterById(value);

        if (!recipient || recipient.owner_discord_id !== action.targetUserId) throw new Error("Recipient character mismatch.");

        const result = unwrap(await db.rpc("purchase_business_item",{
          p_business_id:action.businessId,
          p_item_id:action.itemId,
          p_buyer_character_id:buyer.id,
          p_discord_user_id:i.user.id,
          p_recipient_character_id:recipient.id,
          p_is_gift:true
        }),"gift business item");
        const r = Array.isArray(result)?result[0]:result;

        const publicNotified=await sendJohnNotification({
          i,
          type:"shop_gift",
          payload:{
            embeds:[new EmbedBuilder()
              .setTitle("🎁 Gift Purchase")
              .setDescription(`**${buyer.name}** bought **${recipient.name}** **${r.item_name_out}** for **${nova(r.price_voro_out)}**.`)]
          }
        });

        return respond(i,{
          content:`🎁 **${buyer.name}** bought **${r.item_name_out}** for **${recipient.name}** for **${nova(r.price_voro_out)}**.${publicNotified ? " It was posted publicly." : ""}`
        });
      }

      if (id === "inventory_give_character") {
        const inventoryId=arg1, targetUserId=arg2;
        const giver=await currentCharacter(i);
        const recipient=await characterById(value);

        if(!recipient||recipient.owner_discord_id!==targetUserId) throw new Error("Recipient character mismatch.");
        if(recipient.id===giver.id) throw new Error("Choose a different character to receive the item.");

        const item=unwrap(await db.from("character_inventory")
          .select("id,character_id,item_name,quantity,is_active")
          .eq("id",inventoryId).eq("character_id",giver.id).eq("is_active",true)
          .limit(1),"inventory give final item")?.[0];
        if(!item) throw new Error("That inventory item is no longer available.");

        const result=unwrap(await db.rpc("give_inventory_item",{
          p_inventory_id:item.id,p_giver_character_id:giver.id,
          p_recipient_character_id:recipient.id,p_discord_user_id:i.user.id
        }),"give inventory item");
        const r=Array.isArray(result)?result[0]:result;

        const publicNotified=await sendJohnNotification({
          i,
          type:"item_gift",
          payload:{
            embeds:[new EmbedBuilder()
              .setTitle("🎁 Item Given")
              .setDescription(`**${giver.name}** gave **${recipient.name}** **${r?.item_name_out||item.item_name}**.`)]
          }
        });

        console.log(`[INVENTORY GIVE COMPLETE] item=${item.id} from=${giver.id} to=${recipient.id}`);
        return respond(i,{
          embeds:[new EmbedBuilder().setTitle("🎁 Item Given")
            .setDescription(`**${giver.name}** gave **${r?.item_name_out||item.item_name}** to **${recipient.name}**.${publicNotified?"\n\n📣 This was posted publicly.":""}`)],
          components:[buttonRow([{id:"inventory_back_home",label:"Back to Inventory"}])]
        });
      }

      if (id === "shop_business") {
        if (!i.deferred && !i.replied) {
          try { await i.deferUpdate(); }
          catch (error) {
            if (error?.code === 10062 || error?.code === 40060) {
              console.warn(`[SHOP ACK SKIPPED] shop_business ${error.code}`);
              return;
            }
            throw error;
          }
        }
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        return await shopPageView(i,c,value,0);
      }



      if (id === "shop_items") {
        if (!i.deferred && !i.replied) {
          try { await i.deferUpdate(); }
          catch (error) {
            if (error?.code === 10062 || error?.code === 40060) {
              console.warn(`[SHOP ACK SKIPPED] shop_items ${error.code}`);
              return;
            }
            throw error;
          }
        }

        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const businessId = arg2;
        const page = Number(i.customId.split(":")[3] || 0);
        const selectedIds = [...new Set(i.values)];

        const business = unwrap(await db.from("businesses")
          .select("id,name,business_type,status,logo_url")
          .eq("id",businessId)
          .eq("status","open")
          .limit(1),"cart business")?.[0];
        if (!business) throw new Error("That business is not currently available.");

        const selectedItems = unwrap(await db.from("business_items")
          .select("id,item_name,price_voro,category,description,is_active")
          .eq("business_id",businessId)
          .eq("is_active",true)
          .in("id",selectedIds)
          .order("item_name",{ascending:true}),"cart items") || [];

        if (!selectedItems.length) throw new Error("No available items were selected.");

        const cartToken = makeShopCart({
          buyerCharacterId:c.id,
          businessId,
          businessName:business.name,
          items:selectedItems.map(x=>({
            id:x.id,
            item_name:x.item_name,
            price_voro:Number(x.price_voro||0),
            quantity:1
          })),
          page
        });

        const lines = selectedItems.map(x=>`**${x.item_name}** — ${nova(x.price_voro)} × 1`).join("\n");
        const totalVoro = selectedItems.reduce((sum,item)=>sum+Number(item.price_voro||0),0);

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🛒 ${business.name} — Cart`)
            .setDescription(`${lines}\n\n────────────\n**Order Total: ${nova(totalVoro)}**\n\nUse **Set Quantities** if you want more than one of anything.`)],
          components:[buttonRow([
            {id:`shop_cart_quantities:${cartToken}`,label:"Set Quantities",style:ButtonStyle.Primary},
            {id:`shop_cart_buy:${cartToken}`,label:`Buy All — ${nova(totalVoro)}`,style:ButtonStyle.Success},
            {id:`shop_cart_gift:${cartToken}`,label:"Gift Order"},
            {id:`shop_page:${c.id}:${businessId}:${page}`,label:"Back to Menu"}
          ])]
        });
      }


      if (id === "shop_item") {
        if (!i.deferred && !i.replied) {
          try { await i.deferUpdate(); }
          catch (error) {
            if (error?.code === 10062 || error?.code === 40060) {
              console.warn(`[SHOP ACK SKIPPED] shop_item ${error.code}`);
              return;
            }
            throw error;
          }
        }
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const businessId = arg2;

        const item = unwrap(await db.from("business_items")
          .select("id,business_id,item_name,price_voro,category,description,item_type,is_active")
          .eq("id",value)
          .eq("business_id",businessId)
          .eq("is_active",true)
          .limit(1),"shop item detail")?.[0];

        if (!item) throw new Error("That item is no longer available.");

        const page = Number(i.customId.split(":")[3] || 0);
        const token = makeShopToken({
          buyerCharacterId:c.id,
          businessId,
          itemId:item.id,
          page
        });

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🛒 ${item.item_name}`)
            .setDescription(`${item.description || "No description."}\n\n**Price:** ${nova(item.price_voro)}${item.category ? `\n**Category:** ${item.category}` : ""}\n\nChoose **Buy Now** to continue to checkout or **Gift** to buy it for another character.`)],
          components:[buttonRow([
            {id:`shop_buy:${token}`,label:"Buy Now",style:ButtonStyle.Success},
            {id:`shop_gift:${token}`,label:"Gift"},
            {id:`shop_page:${c.id}:${businessId}:${page}`,label:"Back to Menu"}
          ])]
        });
      }

      if (id === "club_create_preset") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const preset = CLUB_PRESETS[value];
        if (!preset) throw new Error("Unknown club type.");

        return i.showModal(modal(`club_create_modal:${c.id}:${value}`,"Create Club / Group",[
          {id:"name",label:"Club Name",placeholder:preset.label},
          {id:"description",label:"Description",long:true,required:false,placeholder:"What is this group about?"},
          {id:"visibility",label:"Public / Request / Private",placeholder:"public"},
          {id:"dues",label:"Dues",required:false,placeholder:"none OR monthly | 25 OR join | 50"},
          {id:"member_limit",label:"Member Limit",required:false,placeholder:"Leave blank for no limit"}
        ]));
      }

      if (id === "club_browse_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const club = unwrap(await db.from("clubs")
          .select("id,name,preset_key,description,visibility,dues_type,dues_amount_voro,member_limit,status,leader_character_id")
          .eq("id",value).eq("status","active").limit(1),"club browse detail")?.[0];
        if (!club) throw new Error("Club not found.");

        const countResult = unwrap(await db.from("club_members")
          .select("id",{count:"exact"})
          .eq("club_id",club.id).eq("status","active"),"club member count") || [];

        const already = unwrap(await db.from("club_members").select("id,status,role")
          .eq("club_id",club.id).eq("character_id",c.id).limit(1),"club membership check")?.[0];

        const preset=CLUB_PRESETS[club.preset_key]||CLUB_PRESETS.custom;
        const dues=club.dues_type==="none"?"No dues":club.dues_type==="monthly"
          ?`${nova(club.dues_amount_voro||0)}/month`
          :`${nova(club.dues_amount_voro||0)} one-time join fee`;

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle(`🤝 ${club.name}`).setDescription(club.description||preset.description)
            .addFields(
              {name:"Type",value:preset.label,inline:true},
              {name:"Membership",value:club.visibility,inline:true},
              {name:"Dues",value:dues,inline:true},
              {name:"Members",value:String(countResult.length),inline:true}
            )],
          components:already?.status==="active"
            ?[buttonRow([{id:`club_leave:${c.id}:${club.id}`,label:"Leave Club",style:ButtonStyle.Danger}])]
            :club.visibility==="private"
              ?[]
              :[buttonRow([{id:`club_join:${c.id}:${club.id}`,label:club.visibility==="request"?"Request to Join":"Join Club",style:ButtonStyle.Success}])]
        });
      }

      if (id === "club_my_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const membership = unwrap(await db.from("club_members")
          .select("id,role,status,participation_points,clubs(id,name,preset_key,description,visibility,dues_type,dues_amount_voro,status)")
          .eq("club_id",value).eq("character_id",c.id).eq("status","active").limit(1),"my club detail")?.[0];
        if (!membership) throw new Error("Club membership not found.");

        const club=membership.clubs;
        const preset=CLUB_PRESETS[club.preset_key]||CLUB_PRESETS.custom;
        const actionList=preset.actions.map(a=>`• ${a[0]}`).join("\n");

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle(`🤝 ${club.name}`)
            .setDescription(`${club.description||preset.description}\n\n**Available activities**\n${actionList}`)
            .addFields(
              {name:"Role",value:membership.role||"member",inline:true},
              {name:"Participation",value:String(membership.participation_points||0),inline:true},
              {name:"Dues",value:club.dues_type==="none"?"None":club.dues_type==="monthly"?`${nova(club.dues_amount_voro||0)}/month`:`${nova(club.dues_amount_voro||0)} join fee`,inline:true}
            ).setFooter({text:"Club activities are available through /action."})],
          components:membership.role==="leader"?[]:[buttonRow([{id:`club_leave:${c.id}:${club.id}`,label:"Leave Club",style:ButtonStyle.Danger}])]
        });
      }

      if (id === "club_action_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const clubId=arg2;
        const membership=unwrap(await db.from("club_members")
          .select("id,clubs(id,name,preset_key,status)")
          .eq("club_id",clubId).eq("character_id",c.id).eq("status","active").limit(1),"club action membership")?.[0];

        if (!membership||membership.clubs?.status!=="active") throw new Error("You are not an active member of that club.");
        const preset=CLUB_PRESETS[membership.clubs.preset_key]||CLUB_PRESETS.custom;
        const action=preset.actions.find(a=>a[1]===value);
        if (!action) throw new Error("Unknown club activity.");

        const result=unwrap(await db.rpc("run_club_activity",{
          p_club_id:clubId,p_character_id:c.id,p_discord_user_id:i.user.id,p_action_key:value,p_action_name:action[0]
        }),"club activity");
        const activity=Array.isArray(result)?result[0]:result;

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`${activity.outcome_side_out==="good"?"✨":"😵"} ${action[0]}`)
            .setDescription(`**${c.name}** — ${activity.outcome_message_out}`)
            .addFields(
              {name:"Club",value:membership.clubs.name,inline:true},
              {name:"Participation",value:`+${activity.points_earned_out||1} point${Number(activity.points_earned_out||1)===1?"":"s"}`,inline:true}
            )]
        });
      }

      if (id === "bank_deposit_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const accounts = await transferableAccountsFor(c.id);
        const account = accounts.find(a=>a.id===value);
        if (!account) throw new Error("You do not have access to that account.");

        return i.showModal(modal(`bank_deposit_modal:${c.id}:${account.id}`,"Deposit Cash",[
          {id:"amount",label:"Amount in Nova",placeholder:"250.00"},
          {id:"memo",label:"Memo",required:false,placeholder:"Cash deposit"}
        ]));
      }

      if (id === "bank_manage_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const accounts = await transferableAccountsFor(c.id);
        const account = accounts.find(a=>a.id===value);
        if (!account) throw new Error("You do not have access to that account.");

        if (account.kind === "joint") {
          const joint = unwrap(await db.from("joint_accounts")
            .select("id,name,account_type,bank_account_id")
            .eq("bank_account_id",account.id)
            .limit(1),"joint manage")?.[0];

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle(`🏦 ${joint.name}`)
              .setDescription(`Joint ${joint.account_type} • ${nova(account.balance_voro)}`)],
            components:[buttonRow([
              {id:`joint_add_holder:${joint.id}:${c.id}`,label:"Add Holder",style:ButtonStyle.Success},
              {id:`joint_manage_holders:${joint.id}:${c.id}`,label:"Manage Holders"},
              {id:`joint_rename:${joint.id}:${c.id}`,label:"Rename"},
              {id:`joint_close:${joint.id}:${c.id}`,label:"Close Joint Account",style:ButtonStyle.Danger}
            ])]
          });
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🏦 ${account.label}`)
            .setDescription(`Balance: **${nova(account.balance_voro)}**`)],
          components:[buttonRow([
            {id:`bank_close_personal:${c.id}:${account.id}`,label:"Close Account",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "bank_cashout_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const accounts = await transferableAccountsFor(c.id);
        const account = accounts.find(a=>a.id===value);

        if (!account) throw new Error("You do not have access to that account.");
        if (Number(account.balance_voro || 0) <= 0) throw new Error("That account has no Nova to cash out.");

        if (account.kind === "joint") {
          const members = unwrap(await db.from("joint_account_members")
            .select("character_id,role,status,characters(name,owner_discord_id)")
            .eq("joint_account_id",(
              unwrap(await db.from("joint_accounts")
                .select("id")
                .eq("bank_account_id",account.id)
                .limit(1),"joint cashout account")?.[0]?.id
            ))
            .eq("status","active"),"joint cashout members");

          if (!members?.length || members.length < 2) {
            throw new Error("A joint account needs at least two active holders to split a cash out.");
          }

          const each = Math.floor(Number(account.balance_voro) / members.length);
          const remainder = Number(account.balance_voro) - (each * members.length);

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle("💵 Joint Account Cash Out")
              .setDescription(`This is a **joint account**, so John won't let one holder empty it alone.\n\nYou can request to split the full **${nova(account.balance_voro)}** between all active account holders.`)
              .addFields(
                {name:"Holders",value:members.map(m=>`• ${m.characters?.name || "Character"}`).join("\n")},
                {name:"Estimated Split",value:`${nova(each)} each${remainder ? `, with the ${nova(remainder)} remainder added to the requester` : ""}`}
              )
              .setFooter({text:"Every other joint holder must approve before any Nova moves."})],
            components:[buttonRow([
              {id:`joint_cashout_request:${c.id}:${account.id}`,label:"Request Split Cash Out",style:ButtonStyle.Success},
              {id:`bank_cashout_cancel:${c.id}`,label:"Cancel",style:ButtonStyle.Secondary}
            ])]
          });
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("💵 Cash Out Account")
            .setDescription(`Move the full **${nova(account.balance_voro)}** from **${account.label}** into **${c.name}'s cash balance**?`)
            .setFooter({text:"The bank account will stay open with a N0.00 balance."})],
          components:[buttonRow([
            {id:`bank_cashout_confirm:${c.id}:${account.id}`,label:"Cash Out Full Balance",style:ButtonStyle.Success},
            {id:`bank_cashout_cancel:${c.id}`,label:"Cancel",style:ButtonStyle.Secondary}
          ])]
        });
      }

      if (id === "bank_transfer_from") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const accounts = await transferableAccountsFor(c.id);
        const from = accounts.find(a=>a.id===value);
        if (!from) throw new Error("You do not have access to that source account.");

        const destinations = accounts.filter(a=>a.id!==from.id);
        if (!destinations.length) throw new Error("There is no other accessible account to transfer into.");

        return respond(i,{
          content:`Transfer from **${from.label}** (${nova(from.balance_voro)} available). Which account should receive it?`,
          components:[selectRow(`bank_transfer_to:${c.id}:${from.id}`,"Transfer to",destinations.slice(0,25).map(a=>({
            label:a.label.slice(0,100),
            description:`Current balance: ${nova(a.balance_voro)}`.slice(0,100),
            value:a.id
          })))]
        });
      }

      if (id === "bank_transfer_to") {
        const characterId = arg1;
        const fromAccountId = arg2;
        const toAccountId = value;

        const c = await ensureOwnedCharacter(characterId,i.user.id);
        const accounts = await transferableAccountsFor(c.id);
        const from = accounts.find(a=>a.id===fromAccountId);
        const to = accounts.find(a=>a.id===toAccountId);

        if (!from || !to) throw new Error("You no longer have access to one of those accounts.");
        if (from.id === to.id) throw new Error("Choose two different accounts.");

        return i.showModal(modal(
          `bank_transfer_modal:${from.id}:${to.id}`,
          "Transfer Between Accounts",
          [
            {id:"amount",label:"Amount in Nova",placeholder:"250.00"},
            {id:"memo",label:"Memo",required:false,placeholder:"Savings transfer"}
          ]
        ));
      }



      if (id === "business_edit_item") {
        const item = unwrap(await db.from("business_items")
          .select("id,item_name,price_voro,category")
          .eq("id",value)
          .eq("business_id",arg1)
          .limit(1),"edit item")?.[0];
        if (!item) throw new Error("Item not found.");

        return i.showModal(modal(`business_edit_item_modal:${item.id}`,"Edit Business Item",[
          {id:"name",label:"Item Name",value:item.item_name},
          {id:"price",label:"Price",value:(Number(item.price_voro)/100).toFixed(2)},
          {id:"category",label:"Category",value:item.category || ""},
          {id:"description",label:"Description",long:true,required:false,value:item.description || ""}
        ]));
      }

      if (id === "business_remove_item") {
        unwrap(await db.from("business_items").update({is_active:false}).eq("id",value).eq("business_id",arg1),"remove business item");
        return respond(i,{content:"✅ Item removed from the active catalog/menu."});
      }

      if (id === "joint_add_character") {
        const jointId = arg1;
        const ownerCharacterId = arg2;
        const targetUserId = parts[3];
        const invitedCharacterId = value;
        await ensureOwnedCharacter(ownerCharacterId,i.user.id);

        const invited = await characterById(invitedCharacterId);
        if (!invited || invited.owner_discord_id !== targetUserId) throw new Error("Character ownership mismatch.");

        const result = unwrap(await db.rpc("create_existing_joint_holder_invite",{
          p_joint_account_id:jointId,
          p_owner_character_id:ownerCharacterId,
          p_invited_character_id:invitedCharacterId,
          p_owner_discord_id:i.user.id
        }),"joint holder invite");

        const invite = Array.isArray(result) ? result[0] : result;
        try {
          const u = await client.users.fetch(invited.owner_discord_id);
          await u.send({
            content:`🏦 **${invited.name}** was invited to join an existing Equity Financial joint account.`,
            components:[buttonRow([
              {id:`joint_holder_invite_accept:${invite.invite_id}`,label:"Accept",style:ButtonStyle.Success},
              {id:`joint_holder_invite_decline:${invite.invite_id}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
        } catch {}

        return respond(i,{content:`📨 Invitation sent to **${invited.name}**.`});
      }

      if (id === "joint_holder_pick") {
        const jointId = arg1;
        const ownerCharacterId = arg2;
        await ensureOwnedCharacter(ownerCharacterId,i.user.id);

        const member = unwrap(await db.from("joint_account_members")
          .select("id,character_id,role,can_deposit,can_withdraw,can_transfer,characters(name)")
          .eq("id",value)
          .limit(1),"joint member detail")?.[0];

        if (!member) throw new Error("Joint holder not found.");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🏦 ${member.characters?.name || "Joint Holder"}`)
            .setDescription(`Role: **${member.role}**\nDeposit: **${member.can_deposit?"Yes":"No"}**\nWithdraw: **${member.can_withdraw?"Yes":"No"}**\nTransfer: **${member.can_transfer?"Yes":"No"}**`)],
          components: member.role === "owner" ? [] : [buttonRow([
            {id:`joint_toggle_withdraw:${member.id}`,label:"Toggle Withdraw"},
            {id:`joint_toggle_transfer:${member.id}`,label:"Toggle Transfer"},
            {id:`joint_remove_holder:${member.id}`,label:"Remove Holder",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "joint_character") {
        const ownerCharacterId = arg1;
        const targetUserId = arg2;
        const memberCharacterId = value;
        await ensureOwnedCharacter(ownerCharacterId,i.user.id);
        const member = await characterById(memberCharacterId);
        if (!member || member.owner_discord_id !== targetUserId) throw new Error("Character ownership mismatch.");

        return i.showModal(modal(`joint_create_modal:${ownerCharacterId}:${memberCharacterId}`,"Create Joint Account",[
          {id:"name",label:"Account Name",placeholder:"Household Checking"},
          {id:"type",label:"Checking or Savings",placeholder:"checking"}
        ]));
      }


      if (id === "vehicle_share_manage_pick") {
        const access = unwrap(await db.from("vehicle_access")
          .select("id,vehicle_id,character_id,characters(name)")
          .eq("id",value).limit(1),"vehicle access manage")?.[0];
        if (!access) throw new Error("Vehicle share not found.");

        return respond(i,{
          content:`**${access.characters?.name || "This character"}** has full shared access.`,
          components:[buttonRow([
            {id:`vehicle_unshare:${access.id}`,label:"Revoke Shared Access",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "vehicle_transfer_character") {
        const vehicleId = arg1;
        const targetUserId = arg2;
        const newOwnerCharacterId = value;

        const vehicle = unwrap(await db.from("vehicles")
          .select("id,character_id,name")
          .eq("id",vehicleId).limit(1),"vehicle transfer character")?.[0];
        const oldOwner = await ensureOwnedCharacter(vehicle.character_id,i.user.id);
        const newOwner = await characterById(newOwnerCharacterId);
        if (!newOwner || newOwner.owner_discord_id !== targetUserId) throw new Error("Character ownership mismatch.");

        const created = unwrap(await db.rpc("create_vehicle_transfer_invite",{
          p_vehicle_id:vehicleId,
          p_from_character_id:oldOwner.id,
          p_to_character_id:newOwner.id,
          p_from_discord_id:i.user.id
        }),"create vehicle transfer invite");
        const invite = Array.isArray(created) ? created[0] : created;

        let dmSent = false;
        try {
          const user = await client.users.fetch(newOwner.owner_discord_id);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("🚘 Vehicle Ownership Transfer")
              .setDescription(`**${oldOwner.name}** wants to transfer ownership of **${vehicle.name}** to **${newOwner.name}**.`)
              .setFooter({text:"Ownership will not change unless you accept."})],
            components:[buttonRow([
              {id:`vehicle_transfer_accept:${invite.invite_id}`,label:"Accept Vehicle",style:ButtonStyle.Success},
              {id:`vehicle_transfer_decline:${invite.invite_id}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
          dmSent = true;
        } catch (e) {
          console.warn("[Vehicle transfer invite DM failed]",e.message);
        }

        return respond(i,{
          content:`📨 Vehicle transfer request sent to **${newOwner.name}**.${dmSent ? " They received Accept/Decline buttons." : " John couldn't DM them, but the transfer remains pending."}`
        });
      }

      if (id === "vehicle_share_character") {
        const vehicleId = arg1;
        const targetUserId = arg2;
        const memberCharacterId = value;

        const vehicle = unwrap(await db.from("vehicles")
          .select("id,character_id,name")
          .eq("id",vehicleId)
          .limit(1),"share vehicle")?.[0];

        const owner = await ensureOwnedCharacter(vehicle.character_id,i.user.id);
        const member = await characterById(memberCharacterId);
        if (!member || member.owner_discord_id !== targetUserId) throw new Error("Character ownership mismatch.");

        const created = unwrap(await db.rpc("create_vehicle_share_invite",{
          p_vehicle_id:vehicleId,
          p_owner_character_id:owner.id,
          p_member_character_id:member.id,
          p_owner_discord_id:i.user.id,
          p_can_drive:true,
          p_can_buy_gas:true,
          p_can_maintain:true
        }),"create vehicle share invite");
        const invite = Array.isArray(created) ? created[0] : created;

        let dmSent = false;
        try {
          const user = await client.users.fetch(member.owner_discord_id);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("🔑 Vehicle Share Invitation")
              .setDescription(`**${owner.name}** wants to share **${vehicle.name}** with **${member.name}**.`)
              .addFields({name:"Shared Access",value:"Drive • Buy Gas • Maintenance"})
              .setFooter({text:"Accepting gives full shared vehicle access."})],
            components:[buttonRow([
              {id:`vehicle_share_accept:${invite.invite_id}`,label:"Accept Access",style:ButtonStyle.Success},
              {id:`vehicle_share_decline:${invite.invite_id}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
          dmSent = true;
        } catch (e) {
          console.warn("[Vehicle share invite DM failed]",e.message);
        }

        return respond(i,{
          content:`📨 Vehicle sharing request sent to **${member.name}**.${dmSent ? " They received Accept/Decline buttons." : " John couldn't DM them, but the request remains pending."}`
        });
      }

      if (id === "property_split_character") {
        const contractId = arg1;
        const targetUserId = arg2;
        const payerCharacterId = value;
        const contract = unwrap(await db.from("property_contracts").select("id,character_id").eq("id",contractId).limit(1),"split contract owner")?.[0];
        await ensureOwnedCharacter(contract.character_id,i.user.id);
        const payer = await characterById(payerCharacterId);
        if (!payer || payer.owner_discord_id !== targetUserId) throw new Error("Character ownership mismatch.");

        return i.showModal(modal(`property_split_modal:${contractId}:${payerCharacterId}`,"Add Split Payer",[
          {id:"share",label:"Their Share",placeholder:"50% or 1100.00"}
        ]));
      }

      if (id === "create_kind") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        if (value === "job") {
          if (!i.deferred && !i.replied) await i.deferUpdate();
          return respond(i,{
            content:"💼 What kind of job are you creating?",
            components:[selectRow("create_job_mode","Choose job type",[
              {label:"Assign to a Person",description:"Create the job for a specific character",value:"assigned"},
              {label:"General Job",description:"Create an open job that is not assigned yet",value:"general"}
            ])]
          });
        }

        if (value === "vehicle") {
          return i.update({
            content:"🚘 How should this vehicle be added?",
            components:[selectRow("create_vehicle_mode","Choose vehicle type",[
              {label:"Assign to Character",description:"Create a vehicle that already has an owner",value:"assigned"},
              {label:"Add to Marketplace",description:"Create an unowned vehicle that characters can buy",value:"marketplace"}
            ])]
          });
        }

        if (value === "subscription") {
          return i.update({
            content:"📆 Choose the Discord user receiving the subscription:",
            components:[userSelectRow("create_subscription_user","Choose subscriber")]
          });
        }

        if (value === "business") {
          if (!i.deferred && !i.replied) await i.deferUpdate();
          return respond(i,{
            content:"🏪 Who owns this business?",
            components:[selectRow("create_business_ownership","Choose ownership",[
              {label:"Character Owned",value:"character"},
              {label:"NPC Owned",value:"npc"}
            ])]
          });
        }

        if (value === "property") {
          return i.update({
            content:"🏠 How should this property be added?",
            components:[selectRow("create_property_mode","Choose property setup",[
              {label:"Add to Listings",description:"Create housing/property that characters can claim",value:"listing"},
              {label:"Assign to Character",description:"Create the property and immediately assign it",value:"assigned"}
            ])]
          });
        }
      }




      if (id === "create_property_mode") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        if (value === "listing") {
          return i.update({
            content:"🏘️ Should this property be unique or recurring?",
            components:[selectRow("create_property_inventory_listing","Choose inventory type",[
              {label:"Unique Property",description:"Only one can ever be claimed",value:"unique"},
              {label:"Recurring Property",description:"Multiple reusable units can be claimed",value:"recurring"}
            ])]
          });
        }

        if (value === "assigned") {
          return i.update({
            content:"🏠 Choose the Discord user receiving the property:",
            components:[userSelectRow("create_property_user","Choose recipient")]
          });
        }
      }

      if (id === "create_property_inventory_listing") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        return i.showModal(modal(`create_property_listing_modal:${value}`,"Create Property Listing",[
          {id:"name",label:"Property Name"},
          {id:"type",label:"Type",placeholder:"apartment, house, dorm, luxury, commercial"},
          {id:"ownership",label:"Rent or Own",placeholder:"rent or own"},
          {id:"rooms",label:"Bedrooms | Bathrooms | Units",placeholder:value==="recurring" ? "2 | 1.5 | 12" : "4 | 3 | 1"},
          {id:"cost",label:"Monthly Cost in Nova",placeholder:"2200.00"}
        ]));
      }

      if (id === "create_property_inventory_assigned") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const characterId = arg1;
        return i.showModal(modal(`create_property_assigned_modal:${characterId}:${value}`,"Create & Assign Property",[
          {id:"name",label:"Property Name"},
          {id:"type",label:"Type",placeholder:"apartment, house, dorm, luxury, commercial"},
          {id:"ownership",label:"Rent or Own",placeholder:"rent or own"},
          {id:"rooms",label:"Bedrooms | Bathrooms | Units",placeholder:value==="recurring" ? "2 | 1.5 | 12" : "4 | 3 | 1"},
          {id:"cost",label:"Monthly Cost in Nova",placeholder:"2200.00"}
        ]));
      }


      if (id === "create_vehicle_mode") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        if (value === "assigned") {
          return i.update({
            content:"🚘 Choose the Discord user who owns the vehicle:",
            components:[userSelectRow("create_vehicle_user","Choose owner")]
          });
        }

        if (value === "marketplace") {
          return i.showModal(modal("create_vehicle_marketplace_modal","Add Vehicle to Marketplace",[
            {id:"name",label:"Vehicle Name",placeholder:"Range Rover"},
            {id:"year_fuel",label:"Year | Fuel Type",placeholder:"2026 | regular"},
            {id:"tank",label:"Tank Size (gallons)",placeholder:"23.8"},
            {id:"mileage",label:"Starting Mileage",placeholder:"0"},
            {id:"price",label:"Sale Price in Nova",placeholder:"85000.00"}
          ]));
        }
      }


      if (id === "vehicle_menu") {
        const characterId = arg1;
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        if (value === "owned") {
          const rows = unwrap(await db.from("vehicles")
            .select("id,name,year,fuel_percent,condition_percent")
            .eq("character_id",c.id)
            .order("created_at")
            .limit(25),"owned vehicle list");
          if (!rows?.length) return respond(i,{content:"This character doesn't own any vehicles."});

          return respond(i,{
            content:"Choose an owned vehicle:",
            components:[selectRow(`vehicle_owned_pick:${c.id}`,"Owned vehicles",rows.map(v=>({
              label:`${v.year ? `${v.year} ` : ""}${v.name}`.slice(0,100),
              description:`Fuel ${Math.round(Number(v.fuel_percent||0))}% • Condition ${Math.round(Number(v.condition_percent||0))}%`,
              value:v.id
            })))]
          });
        }

        if (value === "shared") {
          const rows = unwrap(await db.from("vehicle_access")
            .select("id,vehicle_id,can_drive,can_buy_gas,can_maintain,vehicles(id,name,year,fuel_percent,condition_percent,character_id)")
            .eq("character_id",c.id)
            .eq("status","active")
            .limit(25),"shared vehicle list");

          const usable = (rows || []).filter(r=>r.vehicles);
          if (!usable.length) return respond(i,{content:"No vehicles are currently shared with this character."});

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle(`🔑 Vehicles Shared With ${c.name}`)
              .setDescription(usable.map(r=>`**${r.vehicles?.year ? `${r.vehicles.year} ` : ""}${r.vehicles?.name || "Vehicle"}** — Shared Access`).join("\n"))
              .setFooter({text:"Choose a vehicle below to view it."})],
            components:[selectRow(`vehicle_shared_pick:${c.id}`,"Choose shared vehicle",usable.map(r=>({
              label:`${r.vehicles?.year ? `${r.vehicles.year} ` : ""}${r.vehicles?.name || "Vehicle"}`.slice(0,100),
              description:`Fuel ${Math.round(Number(r.vehicles?.fuel_percent||0))}% • Condition ${Math.round(Number(r.vehicles?.condition_percent||0))}%`.slice(0,100),
              value:r.vehicle_id
            })))]
          });
        }
        if (value === "marketplace") {
          const rows = unwrap(await db.from("vehicles")
            .select("id,name,year,fuel_type,mileage,condition_percent,sale_price_voro")
            .is("character_id",null)
            .eq("for_sale",true)
            .eq("is_active",true)
            .order("listed_at",{ascending:false})
            .limit(25),"vehicle marketplace");

          if (!rows?.length) {
            return respond(i,{content:"🚘 There are no vehicles for sale right now."});
          }

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle("🚘 Vehicle Marketplace")
              .setDescription("Choose a vehicle to view its details and purchase it with Equity Financial Checking.")],
            components:[selectRow(`vehicle_marketplace_pick:${c.id}`,"Vehicles for sale",rows.map(v=>({
              label:`${v.year ? `${v.year} ` : ""}${v.name}`.slice(0,100),
              description:`${nova(v.sale_price_voro)} • ${Number(v.mileage||0).toLocaleString()} mi • ${Math.round(Number(v.condition_percent||100))}% condition`.slice(0,100),
              value:v.id
            })))]
          });
        }
      }


      if (id === "vehicle_marketplace_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const v = unwrap(await db.from("vehicles")
          .select("id,name,year,fuel_type,tank_size_gallons,mileage,condition_percent,sale_price_voro,for_sale,character_id")
          .eq("id",value)
          .eq("for_sale",true)
          .is("character_id",null)
          .limit(1),"vehicle marketplace detail")?.[0];

        if (!v) throw new Error("That vehicle is no longer available.");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🚘 ${v.year ? `${v.year} ` : ""}${v.name}`)
            .addFields(
              {name:"Price",value:nova(v.sale_price_voro),inline:true},
              {name:"Condition",value:`${Math.round(Number(v.condition_percent||100))}%`,inline:true},
              {name:"Mileage",value:`${Number(v.mileage||0).toLocaleString()} mi`,inline:true},
              {name:"Fuel",value:String(v.fuel_type||"regular"),inline:true},
              {name:"Tank",value:v.tank_size_gallons ? `${v.tank_size_gallons} gal` : "—",inline:true}
            )
            .setFooter({text:"Purchase charges the active character's Equity Financial Checking account."})],
          components:[buttonRow([
            {id:`vehicle_buy:${c.id}:${v.id}`,label:`Buy — ${nova(v.sale_price_voro)}`,style:ButtonStyle.Success}
          ])]
        });
      }



      if (id === "vehicle_shared_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);

        const access = unwrap(await db.from("vehicle_access")
          .select("id,vehicle_id,can_drive,can_buy_gas,can_maintain,status,vehicles(id,name,year,fuel_percent,condition_percent,character_id)")
          .eq("vehicle_id",value)
          .eq("character_id",c.id)
          .eq("status","active")
          .limit(1),"shared vehicle detail")?.[0];

        if (!access?.vehicles) throw new Error("Shared vehicle access not found.");

        const v=access.vehicles;
        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🔑 ${v.year ? `${v.year} ` : ""}${v.name}`)
            .setDescription(`Shared with **${c.name}**\nFuel: **${Math.round(Number(v.fuel_percent||0))}%**\nCondition: **${Math.round(Number(v.condition_percent||0))}%**`)
            .addFields(
              {name:"Drive",value:access.can_drive ? "Allowed" : "Not allowed",inline:true},
              {name:"Buy Gas",value:access.can_buy_gas ? "Allowed" : "Not allowed",inline:true},
              {name:"Maintenance",value:access.can_maintain ? "Allowed" : "Not allowed",inline:true}
            )]
        });
      }


      if (id === "vehicle_owned_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const v = unwrap(await db.from("vehicles")
          .select("*").eq("id",value).eq("character_id",c.id).limit(1),"owned vehicle detail")?.[0];
        if (!v) throw new Error("Vehicle not found.");

        const shares = unwrap(await db.from("vehicle_access")
          .select("id,character_id,can_drive,can_buy_gas,can_maintain,characters(name)")
          .eq("vehicle_id",v.id).eq("status","active"),"vehicle shares");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🚘 ${v.year ? `${v.year} ` : ""}${v.name}`)
            .setDescription(`Owner: **${c.name}**\nFuel: **${Math.round(Number(v.fuel_percent||0))}%**\nCondition: **${Math.round(Number(v.condition_percent||0))}%**\n\nShared with:\n${shares?.length ? shares.map(s=>`• ${s.characters?.name || "Character"}`).join("\n") : "Nobody"}`)],
          components:[buttonRow([
            {id:`vehicle_share:${v.id}`,label:"Share Vehicle",style:ButtonStyle.Success},
            {id:`vehicle_manage_shares:${v.id}`,label:"Manage Shares"},
            {id:`vehicle_transfer_owner:${v.id}`,label:"Transfer Ownership",style:ButtonStyle.Danger}
          ])]
        });
      }


      if (id === "property_unit_label_pick") {
        return i.showModal(modal(`property_unit_label_modal:${value}`,"Label Property Unit",[
          {id:"label",label:"Unit Label",placeholder:"2A or Dorm 312"}
        ]));
      }

      if (id === "property_menu") {
        const characterId = arg1;
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        if (value === "available") {
          const listings = unwrap(await db.from("properties")
            .select("id,name,property_type,ownership_status,bedrooms,bathrooms,monthly_cost_voro,inventory_type,total_units,available_units")
            .eq("status","active")
            .gt("available_units",0)
            .order("name")
            .limit(25),"available properties");

          if (!listings?.length) {
            return respond(i,{content:"There are no available housing listings right now."});
          }

          return respond(i,{
            content:"Choose a housing listing:",
            components:[selectRow(`property_listing:${c.id}`,"Available housing",listings.map(p=>({
              label:p.name.slice(0,100),
              description:`${p.property_type} • ${p.bedrooms ?? 0}BR/${p.bathrooms ?? 0}BA • ${nova(p.monthly_cost_voro)} • ${p.available_units} available`.slice(0,100),
              value:p.id
            })))]
          });
        }

        if (value === "mine") {
          const rows = unwrap(await db.from("property_residents")
            .select("property_id,unit_id,is_payer,properties(name,property_type,ownership_status,monthly_cost_voro),property_units(unit_number,unit_label,status)")
            .eq("character_id",c.id),"my housing");

          if (!rows?.length) {
            return respond(i,{content:`**${c.name}** doesn't currently have housing.`});
          }

          const unique = [];
          const seen = new Set();
          for (const r of rows) {
            const key = `${r.property_id}:${r.unit_id || ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(r);
          }

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle(`🏡 ${c.name}'s Housing`)
              .setDescription(unique.map(r=>{
                const p=r.properties;
                const unit=r.property_units?.unit_label || r.property_units?.unit_number;
                return `**${p?.name || "Property"}**${unit ? ` • ${unit}` : ""}\n${p?.property_type || ""} • ${p?.ownership_status || ""} • ${nova(p?.monthly_cost_voro || 0)}/month`;
              }).join("\n\n"))
              .setFooter({text:"Choose a property below to view details or move out."})],
            components:[selectRow(`property_my_pick:${c.id}`,"Choose your property",unique.slice(0,25).map(r=>({
              label:(r.properties?.name || "Property").slice(0,100),
              description:`${r.property_units?.unit_label || r.property_units?.unit_number || r.properties?.property_type || "Housing"}`.slice(0,100),
              value:r.property_id
            })))]
          });
        }
      }


      if (id === "property_my_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const row = unwrap(await db.from("property_residents")
          .select("property_id,unit_id,is_payer,properties(name,property_type,ownership_status,bedrooms,bathrooms,monthly_cost_voro),property_units(unit_number,unit_label,status)")
          .eq("property_id",value)
          .eq("character_id",c.id)
          .limit(1),"my housing detail")?.[0];

        if (!row) throw new Error("Housing record not found.");

        const p = row.properties || {};
        const unit = row.property_units?.unit_label || row.property_units?.unit_number || "—";

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🏠 ${p.name || "Housing"}`)
            .addFields(
              {name:"Type",value:String(p.property_type || "—"),inline:true},
              {name:"Unit",value:String(unit),inline:true},
              {name:"Bedrooms",value:String(p.bedrooms ?? "—"),inline:true},
              {name:"Bathrooms",value:String(p.bathrooms ?? "—"),inline:true},
              {name:"Monthly Cost",value:nova(p.monthly_cost_voro || 0),inline:true},
              {name:"Role",value:row.is_payer ? "Payer / Resident" : "Resident",inline:true}
            )],
          components:[buttonRow([
            {id:`property_move_out:${row.property_id}:${c.id}`,label:"Move Out / End Lease",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "property_listing") {
        const characterId = arg1;
        const c = await ensureOwnedCharacter(characterId,i.user.id);
        const property = unwrap(await db.from("properties")
          .select("*")
          .eq("id",value)
          .limit(1),"property listing detail")?.[0];

        if (!property) throw new Error("Property listing not found.");

        const unitText = property.inventory_type === "multi_unit"
          ? `${property.available_units} of ${property.total_units} units available`
          : (property.available_units > 0 ? "Available" : "Unavailable");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🏠 ${property.name}`)
            .addFields(
              {name:"Type",value:String(property.property_type),inline:true},
              {name:"Bedrooms",value:String(property.bedrooms ?? 0),inline:true},
              {name:"Bathrooms",value:String(property.bathrooms ?? 0),inline:true},
              {name:property.ownership_status === "own" ? "Monthly Mortgage + Utilities" : "Monthly Rent + Utilities",value:nova(property.monthly_cost_voro),inline:false},
              {name:"Availability",value:unitText,inline:false}
            )],
          components:[buttonRow([
            {
              id:`property_reserve:${property.id}:${c.id}`,
              label:property.ownership_status === "own" ? "Buy This Property" : "Rent This Property",
              style:ButtonStyle.Success
            }
          ])]
        });
      }


      if (id === "job_menu") {
        const characterId = arg1;
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        if (value === "listings") {
          const rows = unwrap(await db.from("general_jobs")
            .select("id,employer_name,position,pay_type,pay_amount_voro,min_pay_voro,max_pay_voro,pay_schedule,listing_type,status")
            .eq("status","open")
            .order("created_at",{ascending:false})
            .limit(25),"job listings");

          if (!rows?.length) {
            return respond(i,{content:"There are no open job listings right now."});
          }

          return respond(i,{
            content:"Choose a job listing:",
            components:[selectRow(`job_listing:${c.id}`,"Open jobs",rows.map(j=>({
              label:`${j.position} — ${j.employer_name}`.slice(0,100),
              description:`${j.pay_type === "random" ? `${nova(j.min_pay_voro)}–${nova(j.max_pay_voro)}` : nova(j.pay_amount_voro)} • ${j.pay_type}${j.pay_schedule ? ` • ${j.pay_schedule}` : ""}${j.listing_type === "recurring" ? " • Recurring" : ""}`.slice(0,100),
              value:j.id
            })))]
          });
        }

        if (value === "mine") {
          const jobs = unwrap(await db.from("jobs")
            .select("id,employer_name,position,pay_type,pay_amount_voro,pay_schedule,status")
            .eq("character_id",c.id)
            .order("created_at",{ascending:false})
            .limit(25),"my jobs");

          if (!jobs?.length) {
            return respond(i,{
              embeds:[new EmbedBuilder().setTitle(`💼 ${c.name}'s Jobs`).setDescription("No jobs yet.")]
            });
          }

          return respond(i,{
            content:"Choose one of your jobs:",
            components:[selectRow(`my_job_pick:${c.id}`,"My jobs",jobs.map(j=>({
              label:`${j.position} — ${j.employer_name}`.slice(0,100),
              description:`${j.status} • ${j.pay_type} • ${nova(j.pay_amount_voro)}`.slice(0,100),
              value:j.id
            })))]
          });
        }
      }


      if (id === "my_job_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const job = unwrap(await db.from("jobs")
          .select("*")
          .eq("id",value)
          .eq("character_id",c.id)
          .limit(1),"my job detail")?.[0];
        if (!job) throw new Error("Job not found.");

        const last = unwrap(await db.from("work_action_claims")
          .select("claimed_at,next_available_at,payout_voro,outcome_side,outcome_message")
          .eq("job_id",job.id)
          .eq("character_id",c.id)
          .order("claimed_at",{ascending:false})
          .limit(1),"last work claim")?.[0];

        const now = Date.now();
        const ready = !last || new Date(last.next_available_at).getTime() <= now;
        const readiness = ready ? "✅ Ready to Work" : `⏳ Ready <t:${Math.floor(new Date(last.next_available_at).getTime()/1000)}:R>`;

        const buttons = [
          {id:`job_work_history:${job.id}:${c.id}`,label:"Work History"}
        ];
        if (job.status === "active" && ["hourly","weekly","salary","random"].includes(job.pay_type)) {
          buttons.unshift({id:`job_work_now:${job.id}:${c.id}`,label:"Work",style:ButtonStyle.Success,disabled:!ready});
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`💼 ${job.position} — ${job.employer_name}`)
            .setDescription(`Status: **${job.status}**\nPay: **${job.pay_type === "random" ? `${nova(job.min_pay_voro)}–${nova(job.max_pay_voro)} per Work` : nova(job.pay_amount_voro)}** • ${job.pay_type}\n${readiness}`)],
          components:[buttonRow(buttons)]
        });
      }

      if (id === "job_listing") {
        const characterId = arg1;
        const c = await ensureOwnedCharacter(characterId,i.user.id);
        const job = unwrap(await db.from("general_jobs")
          .select("*")
          .eq("id",value)
          .eq("status","open")
          .limit(1),"job listing detail")?.[0];

        if (!job) throw new Error("That job listing is no longer available.");

        const existing = unwrap(await db.from("job_applications")
          .select("id,status")
          .eq("general_job_id",job.id)
          .eq("character_id",c.id)
          .in("status",["pending","approved"])
          .limit(1),"existing job application");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`💼 ${job.position}`)
            .setDescription(`**${job.employer_name}**${job.details ? `\n\n${job.details}` : ""}`)
            .addFields(
              {name:"Pay",value:job.pay_type === "random" ? `${nova(job.min_pay_voro)}–${nova(job.max_pay_voro)} • random per Work` : `${nova(job.pay_amount_voro)} • ${job.pay_type}`,inline:true},
              {name:"Pay Schedule",value:job.pay_schedule || "Not specified",inline:true},
              {name:"Listing",value:job.listing_type === "recurring" ? "Recurring — remains open after hires" : "Single opening — closes after a hire",inline:false}
            )],
          components: existing?.length
            ? [buttonRow([{id:`job_withdraw_application:${existing[0].id}`,label:"Withdraw Application",style:ButtonStyle.Danger}])]
            : [buttonRow([{id:`job_apply:${job.id}:${c.id}`,label:"Apply",style:ButtonStyle.Success}])]
        });
      }

      if (id === "create_job_mode") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        if (value === "assigned") {
          // ACK immediately so Discord does not expire this interaction.
          if (!i.deferred && !i.replied) {
            try {
              await i.deferUpdate();
            } catch (error) {
              if (error?.code === 10062 || error?.code === 40060) {
                console.warn(`[CREATE JOB MODE ACK SKIPPED] ${error.code} ${i.id}`);
                return;
              }
              throw error;
            }
          }

          return respond(i,{
            content:"💼 Choose the Discord user who should receive the job:",
            components:[userSelectRow("create_job_user","Choose employee")]
          });
        }

        if (value === "general") {
          return i.showModal(modal("create_general_job_modal","Create General Job",[
            {id:"employer",label:"Employer"},
            {id:"position",label:"Position / Job Title"},
            {id:"pay",label:"Pay / Min | Max in Nova",placeholder:"25.00 OR 50 | 500"},
            {id:"pay_info",label:"Type | Schedule | Listing | Hours",placeholder:"random | daily | recurring | 0"},
            {id:"details",label:"Hours / Requirements / Notes",long:true,required:false,placeholder:"40 hrs/week | Must be 18+ | Mon-Fri"}
          ]));
        }
      }

      if (id === "create_business_ownership") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        if (value === "npc") {
          return i.showModal(modal("create_business_modal:npc:none","Create NPC Business",[
            {id:"name",label:"Business Name"},
            {id:"type",label:"Business Type",placeholder:"shop or restaurant"}
          ]));
        }

        if (!i.deferred && !i.replied) {
          try {
            await i.deferUpdate();
          } catch (error) {
            if (error?.code === 10062 || error?.code === 40060) {
              console.warn(`[CREATE BUSINESS OWNER ACK SKIPPED] ${error.code} ${i.id}`);
              return;
            }
            throw error;
          }
        }

        return respond(i,{
          content:"Choose the Discord user who owns the business:",
          components:[userSelectRow("create_business_owner_user","Choose business owner")]
        });
      }

      if (id === "create_target_character") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const kind = arg1;
        const targetUserId = arg2;
        const characterId = value;
        const c = await characterById(characterId);

        if (!c || c.owner_discord_id !== targetUserId) {
          throw new Error("That character does not belong to the selected Discord user.");
        }

        if (kind === "job") {
          return i.showModal(modal(`create_job_modal:${targetUserId}:${characterId}`,"Create Job",[
            {id:"employer",label:"Employer"},
            {id:"position",label:"Position / Job Title"},
            {id:"pay",label:"Pay / Min | Max in Nova",placeholder:"25.00 OR 50 | 500"},
            {id:"pay_info",label:"Type | Schedule | Hours",placeholder:"random | daily | 0"},
            {id:"hours",label:"Weekly Hours",required:false,placeholder:"40"}
          ]));
        }

        if (kind === "property") {
          return respond(i,{
            content:`🏠 Create property for **${c.name}** — unique or recurring?`,
            components:[selectRow(`create_property_inventory_assigned:${c.id}`,"Choose inventory type",[
              {label:"Unique Property",description:"This is the only copy/unit",value:"unique"},
              {label:"Recurring Property",description:"Assign one unit and leave the others available",value:"recurring"}
            ])]
          });
        }

        if (kind === "vehicle") {
          return i.showModal(modal(`create_vehicle_modal:${characterId}`,"Create Vehicle",[
            {id:"name",label:"Vehicle Name",placeholder:"Range Rover"},
            {id:"year_fuel",label:"Year | Fuel Type",placeholder:"2026 | regular"},
            {id:"tank",label:"Tank Size (gallons)",placeholder:"23.8"},
            {id:"mileage",label:"Starting Mileage",placeholder:"0"},
            {id:"value",label:"Vehicle Value in Nova",required:false,placeholder:"85000.00"}
          ]));
        }

        if (kind === "subscription") {
          return i.showModal(modal(`create_subscription_modal:${characterId}`,"Create Subscription",[
            {id:"name",label:"Subscription Name",placeholder:"Gym Membership"},
            {id:"tier",label:"Tier",required:false,placeholder:"Standard"},
            {id:"cost",label:"Monthly Cost in Nova",placeholder:"50.00"},
            {id:"next",label:"Next Charge Date",required:false,placeholder:"2026-10-04"},
            {id:"action_key",label:"Action Template Key",required:false,placeholder:"gym"}
          ]));
        }

        if (kind === "business") {
          return i.showModal(modal(`create_business_modal:character:${characterId}`,"Create Business",[
            {id:"name",label:"Business Name"},
            {id:"type",label:"Business Type",placeholder:"shop or restaurant"}
          ]));
        }
      }

      if (id === "character_switch_pick") {
        const c = await ensureOwnedCharacter(value,i.user.id);
        await setActiveCharacter(i.user.id,i.guildId,c.id);
        return respond(i, {content:`✅ **${c.name}** is now active in this server.`});
      }

      if (id === "character_view_pick") {
        const c = await ensureOwnedCharacter(value,i.user.id);
        return respond(i, {embeds:[new EmbedBuilder().setTitle(`👤 ${c.name}`).setDescription("Global John character")]});
      }

      if (id === "character_edit_pick") {
        const c = await ensureOwnedCharacter(value,i.user.id);
        return i.showModal(modal(`character_edit_modal:${c.id}`,"Edit Character",[
          {id:"name",label:"Character Name",value:c.name}
        ]));
      }

      if (id === "character_remove_pick") {
        const c = await ensureOwnedCharacter(value,i.user.id);
        return i.showModal(modal(`character_remove_modal:${c.id}`,"Remove Character",[
          {id:"confirm_name",label:`Type ${c.name} exactly`,placeholder:c.name}
        ]));
      }


      if (id === "admin_assign_job_character") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");
        const targetUserId = arg1;
        const characterId = value;
        const c = await characterById(characterId);
        if (!c || c.owner_discord_id !== targetUserId) throw new Error("That character does not belong to the selected user.");

        return i.showModal(modal(
          `admin_assign_job_modal:${targetUserId}:${characterId}`,
          `Assign Job — ${c.name}`,
          [
            {id:"employer",label:"Employer"},
            {id:"position",label:"Position / Job Title"},
            {id:"pay",label:"Pay Amount in Nova",placeholder:"Example: 25.00"},
            {id:"pay_info",label:"Pay Type | Schedule | Listing",placeholder:"hourly | weekly | recurring"},
            {id:"hours",label:"Weekly Hours / Schedule",required:false,placeholder:"40 or Mon-Fri 9-5"}
          ]
        ));
      }

      if (id === "admin_end_job_character") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");
        const targetUserId = arg1;
        const characterId = value;
        const c = await characterById(characterId);
        if (!c || c.owner_discord_id !== targetUserId) throw new Error("That character does not belong to the selected user.");

        const jobs = unwrap(await db.from("jobs")
          .select("id,employer_name,position,pay_type,pay_amount_voro,status")
          .eq("character_id",characterId)
          .in("status",["pending","active","on_leave","suspended"])
          .order("created_at",{ascending:false})
          .limit(25),"admin end jobs");

        if (!jobs?.length) return respond(i,{content:`**${c.name}** has no current jobs to end.`});

        return respond(i,{
          content:`Choose which job to end for **${c.name}**:`,
          components:[selectRow(
            `admin_end_job_pick:${targetUserId}:${characterId}`,
            "Choose job",
            jobs.map(j=>({
              label:`${j.position} — ${j.employer_name}`.slice(0,100),
              description:`${j.status} • ${nova(j.pay_amount_voro)} ${j.pay_type}`.slice(0,100),
              value:j.id
            }))
          )]
        });
      }

      if (id === "admin_end_job_pick") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");
        const targetUserId = arg1;
        const characterId = arg2;
        const jobId = value;

        const jobs = unwrap(await db.from("jobs")
          .select("*")
          .eq("id",jobId)
          .eq("character_id",characterId)
          .limit(1),"job to end");
        const job = jobs?.[0];
        if (!job) throw new Error("Job not found.");

        return i.showModal(modal(
          `admin_end_job_modal:${targetUserId}:${characterId}:${jobId}`,
          "End Job",
          [
            {id:"reason",label:"Reason for ending job",required:false,placeholder:"Optional"},
            {id:"effective",label:"Effective",placeholder:"immediate or end of pay period",value:"immediate"}
          ]
        ));
      }

      if (id === "apps_pick") {
        const c = await currentCharacter(i);
        if (value === "part") return await partHome(i,c);
        if (["vantage","vylt","vybe","nabit"].includes(value)) {
          return await appSubmenu(i,value,c);
        }
        throw new Error("Unknown app.");
      }

      if (id === "app_action") {
        const appName = arg1;
        const characterId = arg2;
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        if (appName === "vylt") {
          if (value === "send") {
            await requireChecking(c.id);
            return i.showModal(modal(`vylt_send:${c.id}`,"VYLT — Send Nova",[
              {id:"recipient",label:"Recipient Discord User ID"},
              {id:"amount",label:"Amount in Nova",placeholder:"25.00"},
              {id:"note",label:"Note",required:false}
            ]));
          }
          if (value === "request") {
            return i.showModal(modal(`vylt_request:${c.id}`,"VYLT — Request Nova",[
              {id:"recipient",label:"Recipient Discord User ID"},
              {id:"amount",label:"Amount in Nova",placeholder:"25.00"},
              {id:"note",label:"Note",required:false}
            ]));
          }
          if (value === "activity") {
            const rows = unwrap(await db.from("vylt_transfers")
              .select("*")
              .or(`sender_character_id.eq.${c.id},receiver_character_id.eq.${c.id}`)
              .order("created_at",{ascending:false})
              .limit(10),"VYLT activity");
            return respond(i,{embeds:[new EmbedBuilder().setTitle("💸 VYLT Activity")
              .setDescription(rows?.length ? rows.map(r=>`${nova(r.amount_voro)} • ${r.status}`).join("\n") : "No VYLT activity yet.")]});
          }
          if (value === "profile") {
            const rows = unwrap(await db.from("vylt_profiles").select("*").eq("character_id",c.id).limit(1),"VYLT profile");
            return respond(i,{embeds:[new EmbedBuilder().setTitle("💚 VYLT Profile")
              .setDescription(rows?.[0] ? `Handle: **${rows[0].vylt_handle}**` : "No VYLT profile yet.")]});
          }
        }

        if (appName === "vybe") {
          if (value === "book") {
            await requireChecking(c.id);
            return i.showModal(modal(`vybe_book:${c.id}`,"VYBE — Book Ride",[
              {id:"destination",label:"Destination",placeholder:"Home, School, Work, Airport..."},
              {id:"distance",label:"Distance",placeholder:"1-5, 5-10, 10-20, 20-40, 40+"},
              {id:"ride_type",label:"Ride Type",placeholder:"Go, Plus, Black, XL, Student..."},
              {id:"riders",label:"Number of Riders",placeholder:"1"},
              {id:"preferences",label:"Preferences",required:false,placeholder:"Quiet, Pet Friendly, Child Seat..."}
            ]));
          }
          const rows = unwrap(await db.from("vybe_rides").select("*").eq("character_id",c.id).order("created_at",{ascending:false}).limit(10),"VYBE rides");
          return respond(i,{embeds:[new EmbedBuilder().setTitle(value==="scheduled"?"🚙 Scheduled VYBE Rides":"🚙 VYBE Ride History")
            .setDescription(rows?.length ? rows.map(r=>`${r.ride_type || "VYBE"} • ${r.destination || "Trip"} • ${r.status}`).join("\n") : "No rides yet.")]});
        }

        if (appName === "nabit") {
          if (value === "order") {
            await requireChecking(c.id);
            const businesses = unwrap(await db.from("businesses").select("id,name,business_type").in("business_type",["restaurant","shop"]).eq("status","open").limit(25),"NABIT businesses");
            if (!businesses?.length) return respond(i,{content:"No open restaurants or shops are available for NABIT yet."});
            return respond(i,{content:"Choose where to order from:",components:[selectRow(`nabit_business:${c.id}`,"Choose business",businesses.map(b=>({label:b.name,value:b.id,description:b.business_type})))]});
          }
          const rows = unwrap(await db.from("nabit_orders").select("*").eq("character_id",c.id).order("created_at",{ascending:false}).limit(10),"NABIT orders");
          return respond(i,{embeds:[new EmbedBuilder().setTitle(value==="tracking"?"🛵 NABIT Tracking":"🛵 NABIT Order History")
            .setDescription(rows?.length ? rows.map(r=>`${r.order_number || r.id} • ${r.status} • ${nova(r.total_voro||0)}`).join("\n") : "No NABIT orders yet.")]});
        }

        if (appName === "vantage") {
          if (value === "shop") {
            return respond(i,{content:"Choose a Vantage category:",components:[selectRow(`vantage_category:${c.id}`,"Choose category",[
              {label:"Electronics",value:"electronics"},{label:"Home",value:"home"},
              {label:"Clothing",value:"clothing"},{label:"Beauty",value:"beauty"},
              {label:"Toys & Games",value:"toys_games"},{label:"Office & School",value:"office_school"},
              {label:"Kitchen",value:"kitchen"},{label:"Furniture",value:"furniture"},
              {label:"Baby & Kids",value:"baby_kids"},{label:"Sports & Fitness",value:"sports_fitness"},
              {label:"Auto & Car Accessories",value:"auto"},{label:"Pet Supplies",value:"pet"},
              {label:"Jewelry & Accessories",value:"jewelry"},{label:"Miscellaneous",value:"misc"}
            ])]});
          }

          if (value === "cart") {
            const cart=await loadVantageCart(c.id,i.user.id);
            if(!cart.items.length){
              return respond(i,{
                embeds:[new EmbedBuilder().setTitle("🛒 Vantage Cart").setDescription("Your cart is empty.")],
                components:[buttonRow([{id:`vantage_continue:${c.id}`,label:"Start Shopping",style:ButtonStyle.Primary}])]
              });
            }
            return respond(i,{
              embeds:[new EmbedBuilder().setTitle("🛒 Vantage Cart")
                .setDescription(`${vantageCartLines(cart)}\n\n**Total: ${nova(vantageCartTotal(cart))}**`)],
              components:[
                buttonRow([
                  {id:`vantage_checkout:${c.id}`,label:"Checkout",style:ButtonStyle.Success},
                  {id:`vantage_clear:${c.id}`,label:"Clear Cart",style:ButtonStyle.Danger}
                ]),
                buttonRow([{id:`vantage_continue:${c.id}`,label:"Continue Shopping"}])
              ]
            });
          }

          const rows=unwrap(await db.from("vantage_orders")
            .select("*").eq("character_id",c.id)
            .order("created_at",{ascending:false}).limit(10),"Vantage orders") || [];

          return respond(i,{embeds:[new EmbedBuilder()
            .setTitle(value==="tracking"?"📦 Kinetix Tracking":"📦 Vantage Orders")
            .setDescription(rows.length
              ? rows.map(r=>`${r.order_number||r.id} • **${r.status||"confirmed"}** • ${nova(r.total_voro||0)}`).join("\n")
              : "No Vantage orders yet.")]});
        }
      }



      if (id === "vantage_category") {
        const c=await ensureOwnedCharacter(arg1,i.user.id);
        const label=VANTAGE_CATEGORY_LABELS[value] || "Vantage";

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle(`🛍️ ${label}`)
            .setDescription(`Shopping for **${c.name}**\nChoose the item size/value tier.`)],
          components:[selectRow(`vantage_size:${c.id}:${value}`,"Choose item size",[
            {label:"Small Item",description:`Starting at ${nova(VANTAGE_PRICES.small)}`,value:"small"},
            {label:"Medium Item",description:`Starting at ${nova(VANTAGE_PRICES.medium)}`,value:"medium"},
            {label:"Large Item",description:`Starting at ${nova(VANTAGE_PRICES.large)}`,value:"large"}
          ])]
        });
      }

      if (id === "vantage_size") {
        const c=await ensureOwnedCharacter(arg1,i.user.id);
        const category=arg2;
        const size=value;
        const categoryLabel=VANTAGE_CATEGORY_LABELS[category] || "Vantage";
        const price=VANTAGE_PRICES[size];
        if(!price) throw new Error("Unknown Vantage item size.");

        const itemName=`${size[0].toUpperCase()+size.slice(1)} ${categoryLabel} Item`;
        const token=makeShopToken({
          vantageCharacterId:c.id,
          category,
          categoryLabel,
          size,
          itemName,
          price_voro:price
        });

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle(`🛒 ${itemName}`)
            .setDescription(`**Price:** ${nova(price)}\n\nAdd it to your cart or buy it now.`)],
          components:[buttonRow([
            {id:`vantage_add:${token}`,label:"Add to Cart",style:ButtonStyle.Primary},
            {id:`vantage_buy_now:${token}`,label:"Buy Now",style:ButtonStyle.Success},
            {id:`vantage_continue:${c.id}`,label:"Keep Shopping"}
          ])]
        });
      }


      if (id === "manage_open") {
        console.log(`[MANAGE OPEN HANDLER ENTERED] customId=${i.customId} user=${i.user.id}`);
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        // Button customId is manage_open:<kind>. In the button handler the
        // second segment is named `arg`, not `arg1`.
        const kind = arg;
        if (!kind) throw new Error("Management category is missing.");

        if (!i.deferred && !i.replied) await i.deferUpdate();
        console.log(`[MANAGE OPEN] kind=${kind} by ${i.user.id}`);
        return await manageList(i,kind);
      }




      if (id === "drive_type") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);

        const tripMap = {
          quick_errand:{label:"Quick Errand",miles:5,fuelUse:3},
          around_town:{label:"Around Town",miles:15,fuelUse:6},
          across_town:{label:"Across Town",miles:30,fuelUse:12},
          road_trip:{label:"Road Trip",miles:100,fuelUse:25}
        };

        if (value === "custom") {
          const token = makeShopToken({driveCharacterId:c.id});
          return i.showModal(modal(
            `drive_custom_modal:${token}`,
            "Custom Drive",
            [{id:"miles",label:"How many miles?",placeholder:"25"}]
          ));
        }

        const trip = tripMap[value];
        if (!trip) throw new Error("Unknown drive type.");

        const token = makeShopToken({
          driveCharacterId:c.id,
          tripKey:value,
          tripLabel:trip.label,
          miles:trip.miles,
          fuelUse:trip.fuelUse
        });

        const owned = unwrap(await db.from("vehicles")
          .select("id,name,year,fuel_percent,condition_percent,character_id")
          .eq("character_id",c.id)
          .eq("is_active",true)
          .order("created_at"),"drive owned vehicles") || [];

        const sharedRows = unwrap(await db.from("vehicle_access")
          .select("vehicle_id,can_drive,vehicles(id,name,year,fuel_percent,condition_percent,character_id,is_active)")
          .eq("character_id",c.id)
          .eq("status","active")
          .eq("can_drive",true),"drive shared vehicles") || [];

        const vehicles = [
          ...owned.map(v=>({...v,shared:false})),
          ...sharedRows
            .filter(r=>r.vehicles?.is_active && r.vehicles?.character_id !== c.id)
            .map(r=>({...r.vehicles,shared:true}))
        ];

        if (!vehicles.length) {
          return respond(i,{content:`🚘 **${c.name}** doesn't have an owned or shared vehicle available to drive.`});
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🚗 ${trip.label}`)
            .setDescription(`Estimated distance: **${trip.miles} miles**\nEstimated fuel use: **${trip.fuelUse}%**\n\nChoose a vehicle.`)],
          components:[selectRow(`drive_vehicle:${token}`,"Choose a vehicle",vehicles.slice(0,25).map(v=>({
            label:`${v.year ? `${v.year} ` : ""}${v.name}`.slice(0,100),
            description:`Fuel ${Math.round(Number(v.fuel_percent||0))}%${v.shared ? " • Shared" : " • Owned"}`.slice(0,100),
            value:v.id
          })))]
        });
      }

      if (id === "drive_vehicle") {
        const action = getShopToken(arg1);
        const c = await ensureOwnedCharacter(action.driveCharacterId,i.user.id);

        const v = unwrap(await db.from("vehicles")
          .select("id,name,year,fuel_percent,condition_percent,character_id,is_active")
          .eq("id",value)
          .eq("is_active",true)
          .limit(1),"drive vehicle detail")?.[0];

        if (!v) throw new Error("That vehicle is not available.");

        if (v.character_id !== c.id) {
          const access = unwrap(await db.from("vehicle_access")
            .select("id,can_drive,status")
            .eq("vehicle_id",v.id)
            .eq("character_id",c.id)
            .eq("status","active")
            .eq("can_drive",true)
            .limit(1),"drive shared access")?.[0];
          if (!access) throw new Error("You do not have permission to drive that vehicle.");
        }

        const fuel = Number(v.fuel_percent||0);
        const needed = Number(action.fuelUse||0);

        if (fuel < needed) {
          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle("⛽ Not Enough Fuel")
              .setDescription(`**${v.name}** has **${Math.round(fuel)}%** fuel, but this trip needs about **${needed}%**.`)]
          });
        }

        const confirmToken = makeShopToken({...action,vehicleId:v.id,vehicleName:v.name});

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🚗 Ready to Drive")
            .setDescription(`**${c.name}** is taking **${v.name}** on a **${action.tripLabel}**.\n\nDistance: **${action.miles} miles**\nFuel before trip: **${Math.round(fuel)}%**\nEstimated fuel used: **${needed}%**`)],
          components:[buttonRow([
            {id:`drive_confirm:${confirmToken}`,label:"Start Drive",style:ButtonStyle.Success},
            {id:`drive_cancel:${confirmToken}`,label:"Cancel"}
          ])]
        });
      }

      if (id === "inventory_item") {
        const c=await ensureOwnedCharacter(arg1,i.user.id);
        console.log(`[INVENTORY ITEM] item=${value} character=${c.id}`);
        return await inventoryItemDetail(i,c,value);
      }

      if (id === "subscription_plan_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        if (!i.deferred && !i.replied) await i.deferUpdate();

        const plan = unwrap(await db.from("subscription_catalog")
          .select("*")
          .eq("id",value)
          .eq("status","active")
          .limit(1),"subscription plan detail")?.[0];

        if (!plan) throw new Error("Subscription plan not found.");

        if (plan.is_custom) {
          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle("🛠️ Custom Subscription")
              .setDescription("Custom subscriptions are still included. A moderator can create one with **/create → Subscription** and choose its name, tier, price, billing date, and optional interaction template.")]
          });
        }

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`📆 ${plan.name}`)
            .setDescription(plan.description || "Monthly subscription")
            .addFields(
              {name:"Monthly Cost",value:nova(plan.monthly_cost_voro),inline:true},
              {name:"Tier",value:plan.tier || "Standard",inline:true},
              {name:"Billing",value:"Monthly",inline:true}
            )
            .setFooter({text:"The first month is charged from Equity Financial Checking when confirmed."})],
          components:[buttonRow([
            {id:`subscription_buy_confirm:${c.id}:${plan.id}`,label:`Subscribe — ${nova(plan.monthly_cost_voro)}`,style:ButtonStyle.Success},
            {id:`subscriptions_browse:${c.id}`,label:"Back"}
          ])]
        });
      }

      if (id === "inventory_filter") {
        const c=await ensureOwnedCharacter(arg1,i.user.id);
        console.log(`[INVENTORY FILTER] ${value} character=${c.id}`);
        return await inventoryHome(i,c,value);
      }

      if (id === "manage_kind") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");
        if (!i.deferred && !i.replied) await i.deferUpdate();
        return await manageList(i,value);
      }

      if (id === "manage_item") {
        let businessAccess=null;
        if(arg1==="businesses") {
          businessAccess=await businessManagementAccess(i,value);
        } else if(!isModerator(i)) {
          throw new Error("Moderator permissions required.");
        }

        if (!i.deferred && !i.replied) await i.deferUpdate();

        let actionOptions = [
          {label:"View Details",value:"view"},
          {label:"Edit",value:"edit"},
          {label:"Remove / End",value:"remove"}
        ];

        if (arg1 === "properties") {
          actionOptions.splice(1,0,{label:"Adjust Unit Count",value:"units"},{label:"Name / Label Units",value:"unit_labels"},{label:"Past Due / Evictions",value:"overdue"});
        }

        if (arg1 === "businesses") {
          actionOptions=[
            {label:"View Details",value:"view"},
            {label:"Catalog / Menu",value:"catalog"},
            {label:"Employees",value:"employees"}
          ];

          // Managers get limited management access. Owners/moderators can also edit
          // the business itself or permanently delete it.
          if(businessAccess?.role!=="manager") {
            actionOptions.push(
              {label:"Edit Business",value:"edit"},
              {label:"Delete Entire Business",value:"remove"}
            );
          }
        }

        return respond(i,{
          content:"What do you want to do with this item?",
          components:[selectRow(`manage_action:${arg1}:${value}`,"Choose action",actionOptions)]
        });
      }

      if (id === "manage_action") {
        const kind = arg1;
        const itemId = arg2;
        let businessAccess=null;

        if(kind==="businesses") {
          businessAccess=await businessManagementAccess(i,itemId);
        } else if(!isModerator(i)) {
          throw new Error("Moderator permissions required.");
        }

        if (!i.deferred && !i.replied) {
          try {
            await i.deferUpdate();
          } catch (error) {
            if (error?.code === 10062 || error?.code === 40060) {
              console.warn(`[MANAGE ACTION ACK SKIPPED] ${error.code} ${i.id}`);
              return;
            }
            throw error;
          }
        }




        if (value === "overdue" && kind === "properties") {
          const bills = unwrap(await db.from("property_billing_cycles")
            .select("id,character_id,amount_voro,late_fee_voro,due_at,status,failure_reason,eviction_eligible_at,characters(name)")
            .eq("property_id",itemId)
            .in("status",["overdue","failed","eviction_eligible"])
            .order("due_at",{ascending:true})
            .limit(25),"property overdue bills");

          if (!bills?.length) {
            return respond(i,{content:"✅ This property has no past-due housing bills."});
          }

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle("⚠️ Past Due Housing")
              .setDescription(bills.map(b=>{
                const total = Number(b.amount_voro||0) + Number(b.late_fee_voro||0);
                const days = Math.max(0,Math.floor((Date.now()-new Date(b.due_at).getTime())/86400000));
                return `**${b.characters?.name || "Character"}** • ${nova(total)} • ${days} day${days===1?"":"s"} past due • **${b.status}**${b.eviction_eligible_at ? `\nEviction eligible: <t:${Math.floor(new Date(b.eviction_eligible_at).getTime()/1000)}:R>` : ""}`;
              }).join("\n\n"))]
          });
        }

        if (value === "unit_labels" && kind === "properties") {
          const units = unwrap(await db.from("property_units")
            .select("id,unit_number,unit_label,status")
            .eq("property_id",itemId)
            .order("unit_number")
            .limit(25),"property unit labels");

          if (!units?.length) return respond(i,{content:"This property has no generated units."});

          return respond(i,{
            content:"Choose a unit to label:",
            components:[selectRow(`property_unit_label_pick:${itemId}`,"Choose unit",units.map(u=>({
              label:`Unit ${u.unit_label || u.unit_number}`.slice(0,100),
              description:u.status,
              value:u.id
            })))]
          });
        }

        if (value === "units" && kind === "properties") {
          const property = unwrap(await db.from("properties")
            .select("id,name,total_units,available_units,reserved_units,occupied_units,inventory_type")
            .eq("id",itemId)
            .limit(1),"manage property units")?.[0];

          if (!property) throw new Error("Property not found.");

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle(`🏢 ${property.name} — Units`)
              .setDescription(`Type: **${property.inventory_type}**\nTotal: **${property.total_units}**\nAvailable: **${property.available_units}**\nReserved: **${property.reserved_units}**\nOccupied: **${property.occupied_units}**`)],
            components:[buttonRow([
              {id:`property_adjust_units:${property.id}`,label:"Change Total Units",style:ButtonStyle.Primary}
            ])]
          });
        }


        if (value === "logo" && kind === "businesses") {
          // manage_action is normally already deferred, but keep this branch safe.
          if(!i.deferred && !i.replied) await i.deferUpdate();

          return respond(i,{
            content:"Send one image attachment in this channel within 2 minutes to replace the business logo.",
            components:[]
          }).then(async ()=>{
            try {
              const collected = await i.channel.awaitMessages({
                filter:m=>m.author.id===i.user.id && m.attachments.size>0,
                max:1,
                time:120000,
                errors:["time"]
              });
              const msg = collected.first();
              const attachment = msg.attachments.first();
              const isImage = attachment?.contentType?.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(attachment?.name || "");
              if (!isImage) return i.followUp({content:"That attachment doesn't look like an image.",flags:64});
              unwrap(await db.from("businesses").update({logo_url:attachment.url}).eq("id",itemId),"change business logo");
              await i.followUp({content:"✅ Business logo updated.",flags:64});
            } catch {
              await i.followUp({content:"Logo upload timed out.",flags:64});
            }
          });
        }

        if (value === "employees" && kind === "businesses") {
          const access=businessAccess || await businessManagementAccess(i,itemId);
          const jobs=unwrap(await db.from("jobs")
            .select("id,character_id,position,pay_type,pay_amount_voro,status,employment_role,work_schedule,characters(name,owner_discord_id)")
            .eq("business_id",itemId)
            .in("status",["pending","active","paused"])
            .order("created_at",{ascending:true})
            .limit(25),"business employees") || [];

          const lines=jobs.map(j=>{
            const role=(j.employment_role||"employee")==="manager"?"Manager":"Employee";
            const state=j.status==="pending"?" • offer pending":"";
            return `**${j.characters?.name || "Character"}** — ${j.position} • ${nova(j.pay_amount_voro)} ${j.pay_type} • ${role}${state}`;
          });

          const buttons=[];
          if(access.role!=="manager") {
            buttons.push({id:`bea:${itemId}`,label:"Add Employee",style:ButtonStyle.Success});
          }
          if(jobs.length) {
            buttons.push({id:`bem:${itemId}`,label:"Manage Employee",style:ButtonStyle.Primary});
          }

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle(`👥 ${access.business.name} — Employees`)
              .setDescription(lines.length?lines.join("\n"):"No employees yet.")],
            components:buttons.length?[buttonRow(buttons)]:[]
          });
        }

        if (value === "payroll" && kind === "businesses") {
          const jobs = unwrap(await db.from("jobs")
            .select("id,character_id,position,pay_type,pay_amount_voro,status,characters(name)")
            .eq("business_id",itemId)
            .eq("status","active")
            .limit(25),"business payroll jobs");

          if (!jobs?.length) return respond(i,{content:"This business has no active employees."});

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle("👥 Employees / Payroll")
              .setDescription(jobs.map(j=>`**${j.characters?.name || "Character"}** — ${j.position} • ${j.pay_type} • ${nova(j.pay_amount_voro)}`).join("\n"))]
          });
        }

        if (value === "catalog" && kind === "businesses") {
          const business = unwrap(await db.from("businesses")
            .select("id,name,business_type,logo_url")
            .eq("id",itemId)
            .limit(1),"business catalog")?.[0];

          if (!business) throw new Error("Business not found.");

          const items = unwrap(await db.from("business_items")
            .select("id,item_name,price_voro,category,description,is_active")
            .eq("business_id",itemId)
            .order("category",{ascending:true})
            .order("item_name",{ascending:true})
            .limit(25),"business catalog items");

          const preview = formatBusinessMenu(items || []);
          const menuEmbed = new EmbedBuilder()
            .setTitle(`${business.business_type === "restaurant" ? "🍽️" : "🛍️"} ${business.name}`)
            .setDescription(`${business.business_type === "restaurant" ? "*MENU*" : "*CATALOG*"}\n\n${preview}\n\n────────────\n*Manage this menu below.*`);

          if (business.logo_url) menuEmbed.setThumbnail(business.logo_url);

          return respond(i,{
            embeds:[menuEmbed],
            components:[
              buttonRow([
                {id:`business_bulk_add:${itemId}`,label:"Quick Add Menu",style:ButtonStyle.Success},
                {id:`business_edit_page:${itemId}:0`,label:"Edit Item"},
                {id:`business_remove_page:${itemId}:0`,label:"Remove Item",style:ButtonStyle.Danger},
                {id:`business_upload_logo:${itemId}`,label:"Upload Logo"}
              ])
            ]
          });
        }

        if (value === "view") {
          const tableMap = {jobs:"jobs",properties:"properties",vehicles:"vehicles",businesses:"businesses",subscriptions:"subscriptions",characters:"characters"};
          const table = tableMap[kind];
          const rows = unwrap(await db.from(table).select("*").eq("id",itemId).limit(1),`manage view ${kind}`);
          const row = rows?.[0];
          if (!row) throw new Error("Item not found.");
          return respond(i,{embeds:[new EmbedBuilder().setTitle(`⚙️ ${kind.slice(0,-1)} Details`)
            .setDescription("```json\n"+JSON.stringify(row,null,2).slice(0,3500)+"\n```")]});
        }
        if (value === "edit") {
          return i.showModal(modal(`manage_edit:${kind}:${itemId}`,"Edit Item",[
            {id:"field",label:"Field to change",placeholder:"Example: status, name, pay_amount_voro"},
            {id:"value",label:"New value"}
          ]));
        }
        if (value === "remove") {
          if(kind==="businesses") {
            if(businessAccess?.role==="manager") throw new Error("Managers cannot delete a business.");
            return respond(i,{
              content:"🚨 **DELETE ENTIRE BUSINESS?** This removes the business record itself — not just menu items or employees. Type-safe confirmation is required.",
              components:[buttonRow([
                {id:`bdcp:${itemId}`,label:"Delete Entire Business",style:ButtonStyle.Danger}
              ])]
            });
          }
          return respond(i,{
            content:"⚠️ Confirm removal/end of this item.",
            components:[buttonRow([
              {id:`manage_remove_confirm:${kind}:${itemId}`,label:"Confirm Remove",style:ButtonStyle.Danger}
            ])]
          });
        }
      }



      if (id === "admin_manual_pay_character") {
        const targetUserId = arg1;
        const characterId = value;
        const c = await characterById(characterId);
        if (!c || c.owner_discord_id !== targetUserId) throw new Error("Character ownership mismatch.");

        const jobs = unwrap(await db.from("jobs")
          .select("id,position,employer_name,pay_type,status")
          .eq("character_id",characterId)
          .eq("status","active")
          .in("pay_type",["commission","custom"])
          .limit(25),"manual pay jobs");

        if (!jobs?.length) return respond(i,{content:"That character has no active commission/custom jobs."});

        return respond(i,{
          content:"Choose a job:",
          components:[selectRow(`admin_manual_pay_job:${characterId}`,"Choose job",jobs.map(j=>({
            label:`${j.position} — ${j.employer_name}`.slice(0,100),
            description:j.pay_type,
            value:j.id
          })))]
        });
      }

      if (id === "admin_manual_pay_job") {
        const characterId = arg1;
        return i.showModal(modal(`admin_manual_pay_modal:${characterId}:${value}`,"Issue Job Pay",[
          {id:"amount",label:"Amount in Nova",placeholder:"250.00"},
          {id:"memo",label:"Reason / Memo",placeholder:"Commission payout"}
        ]));
      }


      if (id === "admin_balance_character") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");

        const c = await characterById(value);
        if (!c) throw new Error("Character not found.");

        return i.showModal(modal(`admin_balance_adjust:${c.id}`,"Adjust Character Balance",[
          {id:"amount",label:"Amount in Nova",placeholder:"100.00 or -50.00"},
          {id:"reason",label:"Reason",placeholder:"Admin grant, correction, prize, etc."}
        ]));
      }

      if (id === "admin_job_application_pick") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");

        const app = unwrap(await db.from("job_applications")
          .select("*,characters(name,owner_discord_id),general_jobs(*)")
          .eq("id",value)
          .eq("status","pending")
          .limit(1),"job application review")?.[0];

        if (!app) throw new Error("That application is no longer pending.");

        const j = app.general_jobs;
        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("📋 NPC Job Application")
            .setDescription(`**${app.characters?.name || "Character"}** applied for **${j?.position || "Job"}** at **${j?.employer_name || "Employer"}**.`)
            .addFields(
              {name:"Age",value:app.age || "Not provided",inline:true},
              {name:"Availability",value:app.availability || "Not provided",inline:true},
              {name:"Experience",value:app.experience || "Not provided"},
              {name:"Why They Want It",value:app.why_apply || "Not provided"},
              {name:"Additional Info",value:app.notes || "None"},
              {name:"Listing Type",value:j?.listing_type === "recurring" ? "Recurring" : "Single opening",inline:true}
            )],
          components:[buttonRow([
            {id:`admin_job_app_accept:${app.id}`,label:"Accept",style:ButtonStyle.Success},
            {id:`admin_job_app_decline:${app.id}`,label:"Decline",style:ButtonStyle.Danger}
          ])]
        });
      }

      if (id === "admin_menu") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");



        if (value === "job_applications") {
          const apps = unwrap(await db.from("job_applications")
            .select("id,character_id,general_job_id,status,created_at,characters(name),general_jobs(position,employer_name)")
            .eq("status","pending")
            .order("created_at",{ascending:true})
            .limit(25),"pending job applications");

          if (!apps?.length) {
            return respond(i,{content:"There are no pending NPC/general job applications."});
          }

          return respond(i,{
            content:"Choose an application to review:",
            components:[selectRow("admin_job_application_pick","Pending applications",apps.map(a=>({
              label:`${a.characters?.name || "Character"} — ${a.general_jobs?.position || "Job"}`.slice(0,100),
              description:`${a.general_jobs?.employer_name || "Employer"}`.slice(0,100),
              value:a.id
            })))]
          });
        }


        if (value === "issue_manual_pay") {
          return respond(i,{
            content:"Choose the Discord user whose character should receive commission/custom pay:",
            components:[userSelectRow("admin_manual_pay_user","Choose user")]
          });
        }

        if (value === "assign_job") {
          return respond(i,{
            content:"Choose the Discord user who should receive the job:",
            components:[userSelectRow("admin_assign_job_user","Choose employee")]
          });
        }

        if (value === "end_job") {
          return respond(i,{
            content:"Choose the Discord user whose job you want to end:",
            components:[userSelectRow("admin_end_job_user","Choose employee")]
          });
        }

        if (value === "logs") {
          const rows = unwrap(await db.from("admin_audit_logs").select("*").order("created_at",{ascending:false}).limit(10),"audit logs");
          return respond(i,{embeds:[new EmbedBuilder().setTitle("📜 Admin Audit Logs")
            .setDescription(rows?.length ? rows.map(r=>`**${r.action_type}** • <t:${Math.floor(new Date(r.created_at).getTime()/1000)}:R>\n${JSON.stringify(r.details||{}).slice(0,180)}`).join("\n\n") : "No audit logs yet.")]});
        }

        if (value === "settings") {
          const rows = unwrap(await db.from("economy_settings").select("*").eq("guild_id",i.guildId).limit(1),"economy settings");
          const s = rows?.[0];
          return respond(i,{embeds:[new EmbedBuilder().setTitle("⚙️ Economy Settings")
            .setDescription(s ? `Bank: **${s.bank_name}**\nStarter: **${nova(s.starting_balance_voro)}**\nNABIT Tax: **${Number(s.nabit_tax_rate)*100}%**\nOverdraft: **${s.allow_overdraft ? "On" : "Off"}**` : "No guild override exists yet; John is using database defaults.")],
            components:[buttonRow([{id:"admin_settings_edit",label:"Edit Settings",style:ButtonStyle.Primary}])]});
        }

        if (value === "balance") {
          const chars = unwrap(await db.from("characters")
            .select("id,name,owner_discord_id")
            .order("name")
            .limit(25),"balance adjustment characters");

          if (!chars?.length) {
            return respond(i,{content:"There are no characters to adjust yet."});
          }

          return respond(i,{
            content:"Which character's balance do you want to adjust?",
            components:[selectRow("admin_balance_character","Choose character",chars.map(c=>({
              label:c.name.slice(0,100),
              description:`Owner: ${c.owner_discord_id}`.slice(0,100),
              value:c.id
            })))]
          });
        }

        if (value === "contracts") {
          const jobs = unwrap(await db.from("job_contracts").select("id,status,created_at").eq("status","pending").limit(10),"job contracts");
          const props = unwrap(await db.from("property_contracts").select("id,status,created_at").eq("status","pending").limit(10),"property contracts");
          return respond(i,{embeds:[new EmbedBuilder().setTitle("📝 Pending Contracts")
            .setDescription(`Job contracts: **${jobs?.length||0}**\nProperty contracts: **${props?.length||0}**`)]});
        }

        if (value === "businesses") {
          const rows = unwrap(await db.from("businesses").select("id,name,business_type,status").order("name").limit(25),"business overview");
          return respond(i,{embeds:[new EmbedBuilder().setTitle("🏪 Business Overview")
            .setDescription(rows?.length ? rows.map(b=>`**${b.name}** • ${b.business_type} • ${b.status}`).join("\n") : "No businesses yet.")]});
        }

        return await adminHome(i);
      }

      if (id === "part_transit") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const labels = {bus:"Bus",light_rail:"Light Rail",train:"Train"};
        return respond(i, {content:`${labels[value]} — choose ticket type:`,components:[selectRow(`part_ticket:${c.id}:${value}`,"Ticket type",[
          {label:`Single Ride — ${nova(PAR_T_FARES[value].single)}`,value:"single"},
          {label:`Round Trip — ${nova(PAR_T_FARES[value].round_trip)}`,value:"round_trip"},
          {label:`Day Pass — ${nova(PAR_T_FARES[value].day_pass)}`,value:"day_pass"},
          {label:`Weekly Pass — ${nova(PAR_T_FARES[value].weekly_pass)}`,value:"weekly_pass"},
          {label:`Monthly Pass — ${nova(PAR_T_FARES[value].monthly_pass)}`,value:"monthly_pass"}
        ])]});
      }

      if (id === "part_ticket") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        return respond(i, {content:"Choose fare type:",components:[selectRow(`part_discount:${c.id}:${arg2}:${value}`,"Fare type",[
          {label:"Standard Fare",value:"standard"},
          {label:"Student — 25% Off",value:"student"},
          {label:"Reduced / Accessibility — 50% Off",value:"reduced"}
        ])]});
      }

      if (id === "part_discount") {
        const [characterId,transitType,ticketType] = [arg1,arg2,i.customId.split(":")[3]];
        const c = await ensureOwnedCharacter(characterId,i.user.id);
        const account = await requireChecking(c.id);
        const discountType = value;
        const base = PAR_T_FARES[transitType][ticketType];
        const fare = Math.round(base * (1 - PAR_T_DISCOUNTS[discountType]));
        return i.showModal(modal(`part_route:${c.id}:${transitType}:${ticketType}:${discountType}:${fare}`,"PAR-T Trip Details",[
          {id:"departure",label:"Departure",placeholder:"Where are you leaving from?"},
          {id:"arrival",label:"Arrival",placeholder:"Where are you going?"},
          {id:"route",label:"Route / Line",required:false,placeholder:"Optional route or line"}
        ]));
      }


      if (id === "action_pick") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);

        if (value === "work") {
          const jobs = unwrap(await db.from("jobs")
            .select("id,position,employer_name,pay_type,pay_amount_voro,min_pay_voro,max_pay_voro,pay_schedule,work_hours_per_shift,status")
            .eq("character_id",c.id)
            .eq("status","active")
            .order("created_at"),"work action jobs");

          const eligible = (jobs || []).filter(j =>
            j.pay_type === "hourly" ||
            j.pay_type === "weekly" ||
            j.pay_type === "salary" ||
            j.pay_type === "random" ||
            String(j.pay_schedule || "").toLowerCase().includes("week")
          );

          if (!eligible.length) {
            throw new Error("This character does not have an active job that supports paid Work actions.");
          }

          return respond(i,{
            content:"Which job are they working?",
            components:[selectRow(`work_job:${c.id}`,"Choose job",eligible.slice(0,25).map(j=>({
              label:`${j.position} — ${j.employer_name}`.slice(0,100),
              description:
                j.pay_type === "random"
                  ? `${nova(j.min_pay_voro)}–${nova(j.max_pay_voro)} random per Work`
                  : j.pay_type === "hourly"
                    ? `${nova(j.pay_amount_voro)}/hr • ${j.work_hours_per_shift || 8} paid hours per shift`
                    : j.pay_type === "salary"
                      ? `${nova(j.pay_amount_voro)} salary • monthly`
                      : `${nova(j.pay_amount_voro)} • weekly`,
              value:j.id
            })))]
          });
        }


        if (value.startsWith("club:")) {
          const clubId=value.split(":")[1];
          const membership=unwrap(await db.from("club_members")
            .select("id,clubs(id,name,preset_key,status)")
            .eq("club_id",clubId).eq("character_id",c.id).eq("status","active").limit(1),"club action membership")?.[0];
          if (!membership||membership.clubs?.status!=="active") throw new Error("That club membership is no longer active.");

          const preset=CLUB_PRESETS[membership.clubs.preset_key]||CLUB_PRESETS.custom;
          return respond(i,{
            content:`Choose an activity for **${membership.clubs.name}**:`,
            components:[selectRow(`club_action_pick:${c.id}:${clubId}`,"Club activity",preset.actions.map(a=>({
              label:a[0],description:preset.label.slice(0,100),value:a[1]
            })))]
          });
        }

        if (value.startsWith("subscription:")) {
          const subscriptionId = value.split(":")[1];
          const result = unwrap(await db.rpc("run_subscription_interaction",{
            p_subscription_id:subscriptionId,
            p_character_id:c.id,
            p_discord_user_id:i.user.id
          }),"subscription interaction");

          const interaction = Array.isArray(result) ? result[0] : result;
          if (!interaction) throw new Error("John couldn't complete that subscription interaction.");

          return respond(i,{
            embeds:[new EmbedBuilder()
              .setTitle(`${interaction.outcome_side === "good" ? "✨" : "😵"} ${interaction.action_name}`)
              .setDescription(`**${c.name}** — ${interaction.message}`)
              .setFooter({text:`${interaction.subscription_name} • ${interaction.outcome_side === "good" ? "Good outcome" : "Bad outcome"}`})]
          });
        }
      }

      if (id === "work_job") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const job = unwrap(await db.from("jobs")
          .select("id,character_id,position,employer_name,pay_type,pay_amount_voro,min_pay_voro,max_pay_voro,pay_schedule,work_hours_per_shift,status")
          .eq("id",value)
          .eq("character_id",c.id)
          .limit(1),"work job")?.[0];

        if (!job || job.status !== "active") throw new Error("That job is not active.");

        const result = unwrap(await db.rpc("claim_work_action",{
          p_job_id:job.id,
          p_character_id:c.id,
          p_discord_user_id:i.user.id
        }),"work action");

        const work = Array.isArray(result) ? result[0] : result;
        if (!work) throw new Error("John couldn't complete the work action.");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`💼 ${c.name} worked at ${job.employer_name}`)
            .setDescription(work.outcome_message)
            .addFields(
              {name:"Position",value:job.position,inline:true},
              {name:"Earned",value:nova(work.payout_voro),inline:true},
              {name:"Outcome",value:work.outcome_side === "good" ? "✨ Good shift" : "😵 Rough shift",inline:true},
              {name:"Next Paid Work",value:`<t:${Math.floor(new Date(work.next_available_at).getTime()/1000)}:R>`}
            )]
        });
      }

      if (id === "sub_action") {
        const c = await ensureOwnedCharacter(arg1,i.user.id);
        const result = unwrap(await db.rpc("get_subscription_action_outcome",{p_subscription_action_id:value}),"subscription action");
        return respond(i, {content:`🎬 **${c.name}** — ${result?.message || result || "Action completed."}`});
      }
    }

    if (i.isModalSubmit()) {
      const parts = i.customId.split(":");
      const id = parts[0];





      if (id === "beom") {
        if(!i.deferred && !i.replied) await i.deferReply({flags:64});

        const businessId=parts[1];
        const targetUserId=parts[2];
        const characterId=parts[3];
        const access=await businessManagementAccess(i,businessId,{ownerOnly:true});
        const c=await characterById(characterId);
        if(!c || c.owner_discord_id!==targetUserId) throw new Error("That character does not belong to the selected Discord user.");

        const position=i.fields.getTextInputValue("position").trim();
        const payVoro=toVoro(i.fields.getTextInputValue("pay"));
        const payType=i.fields.getTextInputValue("pay_type").trim().toLowerCase();
        const schedule=i.fields.getTextInputValue("schedule").trim() || null;
        const role=i.fields.getTextInputValue("role").trim().toLowerCase() || "employee";

        if(!position) throw new Error("Position cannot be blank.");
        if(payVoro===null || payVoro<0) throw new Error("Enter a valid pay amount.");
        if(!["hourly","salary"].includes(payType)) throw new Error("Pay type must be hourly or salary.");
        if(!["employee","manager"].includes(role)) throw new Error("Role must be employee or manager.");

        const existing=unwrap(await db.from("jobs")
          .select("id,status")
          .eq("business_id",businessId)
          .eq("character_id",characterId)
          .in("status",["pending","active","paused"])
          .limit(1),"existing business employee")?.[0];
        if(existing) throw new Error("That character already has an active or pending job at this business.");

        const job=unwrap(await db.from("jobs").insert({
          character_id:characterId,
          business_id:businessId,
          employer_name:access.business.name,
          position,
          pay_type:payType,
          pay_amount_voro:payVoro,
          pay_schedule:null,
          work_schedule:schedule,
          employment_role:role,
          status:"pending"
        }).select().single(),"direct hire job");

        unwrap(await db.from("job_contracts").insert({
          job_id:job.id,
          discord_user_id:targetUserId,
          offered_by_discord_id:i.user.id,
          status:"pending"
        }),"direct hire contract");

        let dmSent=false;
        try {
          const user=await client.users.fetch(targetUserId);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("💼 Job Offer")
              .setDescription(`**${c.name}** has been offered a job at **${access.business.name}**.`)
              .addFields(
                {name:"Position",value:position,inline:true},
                {name:"Pay",value:`${nova(payVoro)} • ${payType}`,inline:true},
                {name:"Role",value:role==="manager"?"Manager":"Employee",inline:true},
                {name:"Schedule",value:schedule || "Not specified"}
              )
              .setFooter({text:"Accepting attaches this job to your character."})],
            components:[buttonRow([
              {id:`job_contract_accept:${job.id}`,label:"Accept Job",style:ButtonStyle.Success},
              {id:`job_contract_decline:${job.id}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
          dmSent=true;
        } catch(e) {
          console.warn("[Direct hire DM failed]",e.message);
        }

        return respond(i,{content:`✅ Job offer created for **${c.name}** as **${position}** at **${access.business.name}**.${dmSent?" I sent the player a private Accept / Decline offer.":" The offer is pending, but I couldn't send the DM."}`});
      }

      if (id === "beem") {
        if(!i.deferred && !i.replied) await i.deferReply({flags:64});

        const businessId=parts[1];
        const jobId=parts[2];
        await businessManagementAccess(i,businessId,{ownerOnly:true});

        const job=unwrap(await db.from("jobs")
          .select("id,position,pay_type,pay_amount_voro,employment_role,work_schedule")
          .eq("id",jobId).eq("business_id",businessId).limit(1),"edit employee job")?.[0];
        if(!job) throw new Error("Employee job not found.");

        const updates={};
        const position=i.fields.getTextInputValue("position").trim();
        const payRaw=i.fields.getTextInputValue("pay").trim();
        const payType=i.fields.getTextInputValue("pay_type").trim().toLowerCase();
        const schedule=i.fields.getTextInputValue("schedule").trim();
        const role=i.fields.getTextInputValue("role").trim().toLowerCase();

        if(position) updates.position=position;
        if(payRaw) {
          const payVoro=toVoro(payRaw);
          if(payVoro===null || payVoro<0) throw new Error("Enter a valid pay amount.");
          updates.pay_amount_voro=payVoro;
        }
        if(payType) {
          if(!["hourly","salary"].includes(payType)) throw new Error("Pay type must be hourly or salary.");
          updates.pay_type=payType;
        }
        if(schedule) updates.work_schedule=schedule;
        if(role) {
          if(!["employee","manager"].includes(role)) throw new Error("Role must be employee or manager.");
          updates.employment_role=role;
        }

        if(!Object.keys(updates).length) return respond(i,{content:"No employee changes were entered."});

        unwrap(await db.from("jobs").update(updates).eq("id",jobId).eq("business_id",businessId),"update employee");
        return respond(i,{content:"✅ Employee position/pay/schedule/role updated."});
      }

      if (id === "bdcm") {
        if(!i.deferred && !i.replied) await i.deferReply({flags:64});
        const businessId=parts[1];
        const access=await businessManagementAccess(i,businessId,{ownerOnly:true});
        const confirm=i.fields.getTextInputValue("confirm_name").trim();
        if(confirm!==access.business.name) throw new Error(`Business name did not match. Type **${access.business.name}** exactly.`);

        unwrap(await db.from("businesses").delete().eq("id",businessId),"delete entire business");
        return respond(i,{content:`🗑️ **${access.business.name}** was permanently deleted.`});
      }

      if (id === "club_create_modal") {
        const c=await ensureOwnedCharacter(parts[1],i.user.id);
        const presetKey=parts[2];
        const preset=CLUB_PRESETS[presetKey];
        if (!preset) throw new Error("Unknown club type.");

        const name=i.fields.getTextInputValue("name").trim();
        const description=i.fields.getTextInputValue("description").trim()||null;
        const visibilityRaw=i.fields.getTextInputValue("visibility").trim().toLowerCase();
        const duesRaw=i.fields.getTextInputValue("dues").trim().toLowerCase();
        const limitRaw=i.fields.getTextInputValue("member_limit").trim();

        if (!name) throw new Error("Club name cannot be blank.");
        const visibility=["public","request","private"].includes(visibilityRaw)?visibilityRaw:"public";

        let duesType="none";
        let duesAmountVoro=0;
        if (duesRaw&&duesRaw!=="none"&&duesRaw!=="no dues") {
          const d=duesRaw.split("|").map(x=>x.trim());
          if (["monthly","month"].includes(d[0])) duesType="monthly";
          else if (["join","joining","one-time","onetime","one time"].includes(d[0])) duesType="join";
          else throw new Error("Dues must be none, monthly | amount, or join | amount.");
          duesAmountVoro=toVoro(d[1]);
          if (duesAmountVoro===null||duesAmountVoro<0) throw new Error("Enter a valid dues amount.");
        }

        const memberLimit=limitRaw?Number(limitRaw):null;
        if (memberLimit!==null&&(!Number.isInteger(memberLimit)||memberLimit<2)) throw new Error("Member limit must be blank or at least 2.");

        unwrap(await db.rpc("create_club",{
          p_name:name,p_preset_key:presetKey,p_description:description,p_visibility:visibility,
          p_dues_type:duesType,p_dues_amount_voro:duesAmountVoro,p_member_limit:memberLimit,
          p_leader_character_id:c.id,p_leader_discord_id:i.user.id
        }),"create club");

        return respond(i,{
          embeds:[new EmbedBuilder().setTitle("🎉 Club Created!").setDescription(`**${name}** is now active.`)
            .addFields(
              {name:"Type",value:preset.label,inline:true},
              {name:"Visibility",value:visibility,inline:true},
              {name:"Dues",value:duesType==="none"?"None":duesType==="monthly"?`${nova(duesAmountVoro)}/month`:`${nova(duesAmountVoro)} join fee`,inline:true}
            ).setFooter({text:"Members can use /action for club activities."})]
        });
      }

      if (id === "business_add_item_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const businessId = parts[1];
        const itemNumber = Number(parts[2] || 1);

        const business = unwrap(await db.from("businesses")
          .select("id,name,business_type")
          .eq("id",businessId)
          .limit(1),"guided add business")?.[0];

        if (!business) throw new Error("Business not found.");

        const itemName = i.fields.getTextInputValue("name").trim();
        const priceVoro = toVoro(i.fields.getTextInputValue("price"));
        const category = i.fields.getTextInputValue("category").trim();
        const description = i.fields.getTextInputValue("description").trim() || null;

        if (!itemName) throw new Error("Item name is required.");
        if (priceVoro === null || priceVoro < 0) throw new Error("Enter a valid price.");
        if (!category) throw new Error("Category is required.");

        unwrap(await db.from("business_items").insert({
          business_id:businessId,
          item_name:itemName,
          price_voro:priceVoro,
          category,
          description,
          item_type:business.business_type === "restaurant" ? "consumable" : "owned",
          is_active:true
        }),"guided add item");

        if (itemNumber < 5) {
          return respond(i,{
            content:`✅ Item ${itemNumber} saved: **${itemName}** — ${nova(priceVoro)} • ${category}`,
            components:[buttonRow([
              {id:`business_next_item:${businessId}:${itemNumber + 1}`,label:`Add Item ${itemNumber + 1}`,style:ButtonStyle.Success},
              {id:`business_view_catalog:${businessId}`,label:"Stop & View Menu"}
            ])]
          });
        }

        return respond(i,{
          content:`✅ Item 5 saved. You finished this 5-item batch for **${business.name}**.`,
          components:[buttonRow([
            {id:`business_bulk_add:${businessId}`,label:"Quick Add More",style:ButtonStyle.Success},
            {id:`business_view_catalog:${businessId}`,label:"View Catalog / Menu"},
            {id:`business_upload_logo:${businessId}`,label:"Upload Logo"}
          ])]
        });
      }










      if (id === "drive_custom_modal") {
        const action = getShopToken(parts[1]);
        const c = await ensureOwnedCharacter(action.driveCharacterId,i.user.id);

        const miles = Number(i.fields.getTextInputValue("miles").trim());
        if (!Number.isFinite(miles) || miles <= 0 || miles > 2000) {
          throw new Error("Enter a distance between 1 and 2,000 miles.");
        }

        const fuelUse = Math.max(1,Math.min(100,Math.ceil(miles/10)));

        const token = makeShopToken({
          driveCharacterId:c.id,
          tripKey:"custom",
          tripLabel:"Custom Drive",
          miles:Math.round(miles*10)/10,
          fuelUse
        });

        const owned = unwrap(await db.from("vehicles")
          .select("id,name,year,fuel_percent,condition_percent,character_id")
          .eq("character_id",c.id)
          .eq("is_active",true)
          .order("created_at"),"custom drive owned vehicles") || [];

        const sharedRows = unwrap(await db.from("vehicle_access")
          .select("vehicle_id,can_drive,vehicles(id,name,year,fuel_percent,condition_percent,character_id,is_active)")
          .eq("character_id",c.id)
          .eq("status","active")
          .eq("can_drive",true),"custom drive shared vehicles") || [];

        const vehicles = [
          ...owned.map(v=>({...v,shared:false})),
          ...sharedRows
            .filter(r=>r.vehicles?.is_active && r.vehicles?.character_id !== c.id)
            .map(r=>({...r.vehicles,shared:true}))
        ];

        if (!vehicles.length) return respond(i,{content:`🚘 **${c.name}** has no vehicle available to drive.`});

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🚗 Custom Drive")
            .setDescription(`Distance: **${miles} miles**\nEstimated fuel use: **${fuelUse}%**\n\nChoose a vehicle.`)],
          components:[selectRow(`drive_vehicle:${token}`,"Choose a vehicle",vehicles.slice(0,25).map(v=>({
            label:`${v.year ? `${v.year} ` : ""}${v.name}`.slice(0,100),
            description:`Fuel ${Math.round(Number(v.fuel_percent||0))}%${v.shared ? " • Shared" : " • Owned"}`.slice(0,100),
            value:v.id
          })))]
        });
      }


      if (id === "shop_cart_quantity_modal") {
        const cartToken = parts[1];
        const itemIndex = Number(parts[2]);
        const cart = getShopCart(cartToken);
        const c = await ensureOwnedCharacter(cart.buyerCharacterId,i.user.id);

        const qty = Number(i.fields.getTextInputValue("quantity").trim());
        if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
          throw new Error("Quantity must be a whole number from 1 to 99.");
        }

        if (!cart.items[itemIndex]) throw new Error("Cart item not found.");
        cart.items[itemIndex].quantity = qty;
        shopCarts.set(cartToken,cart);

        const totalVoro = cart.items.reduce((sum,item)=>sum+(Number(item.price_voro||0)*Number(item.quantity||1)),0);
        const lines = cart.items.map(x=>`**${x.item_name}** — ${nova(x.price_voro)} × ${x.quantity}`).join("\n");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle(`🛒 ${cart.businessName} — Cart`)
            .setDescription(`${lines}\n\n────────────\n**Order Total: ${nova(totalVoro)}**`)],
          components:[
            buttonRow([
              {id:`shop_cart_quantities:${cartToken}`,label:"Set More Quantities",style:ButtonStyle.Primary},
              {id:`shop_cart_buy:${cartToken}`,label:`Buy All — ${nova(totalVoro)}`,style:ButtonStyle.Success},
              {id:`shop_cart_gift:${cartToken}`,label:"Gift Order"},
              {id:`shop_page:${c.id}:${cart.businessId}:${cart.page || 0}`,label:"Back to Menu"}
            ])
          ]
        });
      }


      if (id === "business_quick_add_modal") {
        const businessId=parts[1];
        const business=await ensureBusinessOwnerOrModerator(i,businessId);

        const defaultCategory=i.fields.getTextInputValue("category").trim();
        const raw=i.fields.getTextInputValue("items").trim();
        if(!raw) throw new Error("Paste at least one menu item.");

        const lines=raw.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        if(lines.length>25) throw new Error("Quick Add supports up to 25 items at a time.");

        const rows=[];
        const errors=[];

        for(let n=0;n<lines.length;n++){
          const partsLine=lines[n].split("|").map(x=>x.trim());
          if(partsLine.length<2){
            errors.push(`Line ${n+1}: use Name | Price | Description`);
            continue;
          }

          const itemName=partsLine[0];
          const priceVoro=toVoro(partsLine[1]);
          let category=defaultCategory;
          let description=null;

          if(partsLine.length>=4){
            category=partsLine[2] || defaultCategory;
            description=partsLine.slice(3).join(" | ").trim() || null;
          }else if(partsLine.length===3){
            description=partsLine[2] || null;
          }

          if(!itemName){ errors.push(`Line ${n+1}: item name is missing`); continue; }
          if(priceVoro===null || priceVoro<0){ errors.push(`Line ${n+1}: invalid price`); continue; }
          if(!category){
            errors.push(`Line ${n+1}: add a batch category or use Name | Price | Category | Description`);
            continue;
          }

          rows.push({
            business_id:businessId,
            item_name:itemName,
            price_voro:priceVoro,
            category,
            description,
            item_type:business.business_type==="restaurant" ? "consumable" : "owned",
            is_active:true
          });
        }

        if(errors.length){
          throw new Error(`Fix these menu lines:\n${errors.slice(0,8).join("\n")}${errors.length>8 ? `\n…and ${errors.length-8} more.` : ""}`);
        }
        if(!rows.length) throw new Error("No valid menu items were found.");

        unwrap(await db.from("business_items").insert(rows),"quick add business items");

        const categories=[...new Set(rows.map(r=>r.category))];
        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("✅ Menu Items Added")
            .setDescription(`Added **${rows.length} item${rows.length===1?"":"s"}** to **${business.name}** in one batch.`)
            .addFields(
              {name:"Categories",value:categories.join(", ").slice(0,1024)},
              {name:"Quick Add Format",value:"Use **Name | Price | Description** with a batch category, or **Name | Price | Category | Description** to mix categories."}
            )],
          components:[buttonRow([
            {id:`business_bulk_add:${businessId}`,label:"Add Another Batch",style:ButtonStyle.Success},
            {id:`business_view_catalog:${businessId}`,label:"View Menu / Catalog"}
          ])]
        });
      }


      if (id === "business_add_item_single_modal") {
        const businessId = parts[1];
        const business = await ensureBusinessOwnerOrModerator(i,businessId);

        const itemName = i.fields.getTextInputValue("name").trim();
        const priceVoro = toVoro(i.fields.getTextInputValue("price"));
        const category = i.fields.getTextInputValue("category").trim();
        const description = i.fields.getTextInputValue("description").trim() || null;

        if (!itemName) throw new Error("Item name is required.");
        if (priceVoro === null || priceVoro < 0) throw new Error("Enter a valid price.");
        if (!category) throw new Error("Category is required.");

        unwrap(await db.from("business_items").insert({
          business_id:businessId,
          item_name:itemName,
          price_voro:priceVoro,
          category,
          description,
          item_type:business.business_type === "restaurant" ? "consumable" : "owned",
          is_active:true
        }),"add single business item");

        return respond(i,{
          content:`✅ Added **${itemName}** — **${nova(priceVoro)}** to **${business.name}**.`
        });
      }


      if (id === "business_edit_item_modal") {
        const itemId = parts[1];
        const name = i.fields.getTextInputValue("name").trim();
        const priceVoro = toVoro(i.fields.getTextInputValue("price"));
        const category = i.fields.getTextInputValue("category").trim() || null;
        const description = i.fields.getTextInputValue("description").trim() || null;
        if (priceVoro === null || priceVoro < 0) throw new Error("Enter a valid price.");

        unwrap(await db.from("business_items").update({
          item_name:name,
          price_voro:priceVoro,
          category,
          description
        }).eq("id",itemId),"edit business item");

        return respond(i,{content:`✅ Updated **${name}** to **${nova(priceVoro)}**${category ? ` in **${category}**` : ""}.`});
      }

      if (id === "bank_deposit_modal") {
        const characterId = parts[1];
        const accountId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);
        const amountVoro = toVoro(i.fields.getTextInputValue("amount"));
        const memo = i.fields.getTextInputValue("memo").trim() || null;

        if (amountVoro === null || amountVoro <= 0) throw new Error("Enter a valid deposit amount.");

        const result = unwrap(await db.rpc("deposit_cash_to_accessible_account",{
          p_account_id:accountId,
          p_character_id:c.id,
          p_discord_user_id:i.user.id,
          p_amount_voro:amountVoro,
          p_memo:memo
        }),"cash deposit");

        const r = Array.isArray(result) ? result[0] : result;
        return respond(i,{content:`✅ Deposited **${nova(amountVoro)}** into **${r.account_label}**. New balance: **${nova(r.account_balance_voro)}**.`});
      }

      if (id === "joint_rename_modal") {
        const jointId = parts[1];
        const characterId = parts[2];
        await ensureOwnedCharacter(characterId,i.user.id);
        const name = i.fields.getTextInputValue("name").trim();
        unwrap(await db.rpc("rename_joint_account",{
          p_joint_account_id:jointId,
          p_actor_discord_id:i.user.id,
          p_name:name
        }),"rename joint account");
        return respond(i,{content:`✅ Joint account renamed to **${name}**.`});
      }

      if (id === "bank_transfer_modal") {
        const fromAccountId = parts[1];
        const toAccountId = parts[2];

        const c = await currentCharacter(i);
        const amountVoro = toVoro(i.fields.getTextInputValue("amount"));
        const memo = i.fields.getTextInputValue("memo").trim() || null;

        if (amountVoro === null || amountVoro <= 0) {
          throw new Error("Enter a valid transfer amount greater than N0.00.");
        }

        const result = unwrap(await db.rpc("transfer_between_accessible_accounts",{
          p_from_account_id:fromAccountId,
          p_to_account_id:toAccountId,
          p_character_id:c.id,
          p_discord_user_id:i.user.id,
          p_amount_voro:amountVoro,
          p_memo:memo
        }),"bank account transfer");

        const transfer = Array.isArray(result) ? result[0] : result;
        if (!transfer) throw new Error("John couldn't complete the transfer.");

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("🏦 Equity Financial — Transfer Complete")
            .setDescription(`Transferred **${nova(amountVoro)}** successfully.`)
            .addFields(
              {name:"From",value:transfer.from_label || "Account",inline:true},
              {name:"To",value:transfer.to_label || "Account",inline:true},
              {name:"From Balance",value:nova(transfer.from_balance_voro),inline:true},
              {name:"To Balance",value:nova(transfer.to_balance_voro),inline:true},
              {name:"Reference",value:transfer.reference_number || "—",inline:false},
              ...(memo ? [{name:"Memo",value:memo}] : [])
            )]
        });
      }

      if (id === "joint_create_modal") {
        const ownerCharacterId = parts[1];
        const memberCharacterId = parts[2];
        const owner = await ensureOwnedCharacter(ownerCharacterId,i.user.id);
        const member = await characterById(memberCharacterId);
        if (!member) throw new Error("Joint account invitee not found.");

        const name = i.fields.getTextInputValue("name").trim();
        const type = i.fields.getTextInputValue("type").trim().toLowerCase();
        if (!["checking","savings"].includes(type)) throw new Error("Joint account type must be checking or savings.");

        const result = unwrap(await db.rpc("create_joint_account_invite",{
          p_name:name,
          p_account_type:type,
          p_owner_character_id:owner.id,
          p_invited_character_id:member.id,
          p_created_by_discord_id:i.user.id
        }),"create joint account invite");

        const invite = Array.isArray(result) ? result[0] : result;
        if (!invite?.invite_id) throw new Error("John couldn't create the joint account invitation.");

        let dmSent = false;
        try {
          const user = await client.users.fetch(member.owner_discord_id);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("🏦 Equity Financial — Joint Account Invitation")
              .setDescription(`**${owner.name}** invited **${member.name}** to open a joint **${type}** account named **${name}**.`)
              .addFields(
                {name:"Bank",value:"Equity Financial",inline:true},
                {name:"Account Type",value:type === "checking" ? "Checking" : "Savings",inline:true},
                {name:"Starting Balance",value:"N0.00",inline:true}
              )
              .setFooter({text:"The account will not become active until you accept."})],
            components:[buttonRow([
              {id:`joint_invite_accept:${invite.invite_id}`,label:"Accept Joint Account",style:ButtonStyle.Success},
              {id:`joint_invite_decline:${invite.invite_id}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
          dmSent = true;
        } catch (e) {
          console.warn("[Joint account invite DM failed]",e.message);
        }

        return respond(i,{
          content:`📨 Joint account invitation created for **${member.name}**.${dmSent ? " They were sent an Accept/Decline request by DM." : " John couldn't DM them, but the invitation is still pending."}`
        });
      }

      if (id === "property_split_modal") {
        const contractId = parts[1];
        const payerCharacterId = parts[2];
        const contract = unwrap(await db.from("property_contracts")
          .select("id,property_id,character_id,properties(name,monthly_cost_voro)")
          .eq("id",contractId).limit(1),"split property")?.[0];
        const owner = await ensureOwnedCharacter(contract.character_id,i.user.id);
        const payer = await characterById(payerCharacterId);
        if (!payer) throw new Error("Payer character not found.");

        const raw = i.fields.getTextInputValue("share").trim();
        const total = Number(contract.properties.monthly_cost_voro);
        let shareVoro;
        if (raw.endsWith("%")) {
          const pct = Number(raw.slice(0,-1));
          if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) throw new Error("Percentage must be between 0 and 100.");
          shareVoro = Math.round(total * (pct/100));
        } else {
          shareVoro = toVoro(raw);
          if (shareVoro === null || shareVoro <= 0 || shareVoro >= total) throw new Error("Enter a valid Nova share smaller than the total housing cost.");
        }

        const result = unwrap(await db.rpc("add_property_split_payer",{
          p_contract_id:contractId,
          p_payer_character_id:payer.id,
          p_payer_discord_id:payer.owner_discord_id,
          p_share_voro:shareVoro
        }),"add split payer");
        const member = Array.isArray(result) ? result[0] : result;
        const payerRecordId = member?.payer_id_out || member?.payer_id;
        if (!payerRecordId) throw new Error("John couldn't create the split payer request.");

        try {
          const user = await client.users.fetch(payer.owner_discord_id);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("🏠 Split Housing Payment Request")
              .setDescription(`**${owner.name}** wants **${payer.name}** to share the payment for **${contract.properties.name}**.`)
              .addFields({name:"Your Monthly Share",value:nova(shareVoro),inline:true})],
            components:[buttonRow([
              {id:`property_split_accept:${payerRecordId}`,label:"Accept Split",style:ButtonStyle.Success},
              {id:`property_split_decline:${payerRecordId}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
        } catch {}

        return respond(i,{content:`✅ Added **${payer.name}** as a proposed payer for **${nova(shareVoro)}/month**. They were sent an acceptance request.`});
      }


      if (id === "admin_manual_pay_modal") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");
        const characterId = parts[1];
        const jobId = parts[2];
        const amountVoro = toVoro(i.fields.getTextInputValue("amount"));
        const memo = i.fields.getTextInputValue("memo").trim();
        if (amountVoro === null || amountVoro <= 0) throw new Error("Enter a valid amount.");

        const result = unwrap(await db.rpc("issue_manual_job_pay",{
          p_job_id:jobId,
          p_character_id:characterId,
          p_admin_discord_id:i.user.id,
          p_amount_voro:amountVoro,
          p_memo:memo
        }),"issue manual job pay");
        const r = Array.isArray(result) ? result[0] : result;

        return respond(i,{content:`✅ Issued **${nova(amountVoro)}** for **${r.position}** at **${r.employer_name}**.`});
      }

      if (id === "job_apply_modal") {
        const generalJobId = parts[1];
        const characterId = parts[2];
        const c = await ensureOwnedCharacter(characterId,i.user.id);

        const listing = unwrap(await db.from("general_jobs")
          .select("id,position,employer_name,status")
          .eq("id",generalJobId)
          .limit(1),"application listing")?.[0];

        if (!listing || listing.status !== "open") throw new Error("That job listing is no longer open.");

        const age = i.fields.getTextInputValue("age").trim() || null;
        const experience = i.fields.getTextInputValue("experience").trim() || null;
        const availability = i.fields.getTextInputValue("availability").trim();
        const whyApply = i.fields.getTextInputValue("why").trim();
        const notes = i.fields.getTextInputValue("notes").trim() || null;

        const existing = unwrap(await db.from("job_applications")
          .select("id,status")
          .eq("general_job_id",generalJobId)
          .eq("character_id",characterId)
          .in("status",["pending","approved"])
          .limit(1),"duplicate application");

        if (existing?.length) throw new Error("This character already has a pending or approved application for that listing.");

        unwrap(await db.from("job_applications").insert({
          general_job_id:generalJobId,
          character_id:characterId,
          applicant_discord_id:i.user.id,
          age,
          experience,
          availability,
          why_apply:whyApply,
          notes,
          status:"pending"
        }),"submit job application");

        return respond(i,{
          content:`📨 **${c.name}** applied for **${listing.position}** at **${listing.employer_name}**. The application is now waiting for admin review.`
        });
      }


      if (id === "property_unit_label_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");
        const unitId = parts[1];
        const label = i.fields.getTextInputValue("label").trim();
        unwrap(await db.from("property_units").update({unit_label:label}).eq("id",unitId),"label property unit");
        return respond(i,{content:`✅ Unit label updated to **${label}**.`});
      }

      if (id === "property_adjust_units_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const propertyId = parts[1];
        const totalUnits = Number(i.fields.getTextInputValue("units").trim());
        if (!Number.isInteger(totalUnits) || totalUnits < 1) {
          throw new Error("Total units must be a whole number of at least 1.");
        }

        const result = unwrap(await db.rpc("set_property_unit_count",{
          p_property_id:propertyId,
          p_total_units:totalUnits
        }),"set property unit count");

        const updated = Array.isArray(result) ? result[0] : result;
        return respond(i,{
          content:`✅ Unit count updated. Total: **${updated.total_units}** • Available: **${updated.available_units}** • Occupied: **${updated.occupied_units}**.`
        });
      }

      if (id === "create_general_job_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const employer = i.fields.getTextInputValue("employer").trim();
        const position = i.fields.getTextInputValue("position").trim();
        const payRaw = i.fields.getTextInputValue("pay").trim();
        const payInfo = i.fields.getTextInputValue("pay_info").split("|").map(x=>x.trim().toLowerCase());
        const details = i.fields.getTextInputValue("details").trim() || null;

        const payType = payInfo[0] === "variable" ? "random" : payInfo[0];
        const paySchedule = payInfo[1] || null;
        const payParts = payRaw.split("|").map(x=>x.trim());
        const minPayVoro = payType === "random" ? toVoro(payParts[0]) : null;
        const maxPayVoro = payType === "random" ? toVoro(payParts[1]) : null;
        const payVoro = payType === "random" ? minPayVoro : toVoro(payRaw);
        const listingRaw = payInfo[2] || "single";
        const listingType = ["recurring","repeat","repeating","multi"].includes(listingRaw) ? "recurring" : "single";
        const workHoursPerShift = payType === "hourly" ? Number(payInfo[3] || 8) : null;

        if (!["salary","hourly","weekly","commission","custom","random"].includes(payType)) {
          throw new Error("Pay type must be salary, hourly, weekly, commission, custom, or random.");
        }
        if (payType === "random") {
          if (minPayVoro === null || maxPayVoro === null || minPayVoro < 0 || maxPayVoro < minPayVoro) {
            throw new Error("Random jobs need Pay entered as MIN | MAX, for example 50 | 500.");
          }
        } else if (payVoro === null || payVoro < 0) {
          throw new Error("Enter a valid pay amount.");
        }
        if (payType === "hourly" && (!Number.isFinite(workHoursPerShift) || workHoursPerShift <= 0 || workHoursPerShift > 24)) {
          throw new Error("Hourly jobs need paid hours per shift between 1 and 24.");
        }

        const row = unwrap(await db.from("general_jobs").insert({
          employer_name:employer,
          position,
          pay_type:payType,
          pay_amount_voro:payVoro,
          min_pay_voro:minPayVoro,
          max_pay_voro:maxPayVoro,
          pay_schedule:paySchedule,
          details,
          listing_type:listingType,
          work_hours_per_shift:workHoursPerShift,
          status:"open",
          created_by_discord_id:i.user.id
        }).select().single(),"create general job");

        unwrap(await db.from("admin_audit_logs").insert({
          guild_id:i.guildId,
          moderator_discord_id:i.user.id,
          action_type:"create_general_job",
          details:{
            general_job_id:row.id,
            employer_name:employer,
            position,
            pay_type:payType,
            pay_amount_voro:payVoro,
            pay_schedule:paySchedule,
            listing_type:listingType
          }
        }),"audit general job");

        return respond(i,{
          content:`✅ General job created: **${position}** at **${employer}** — **${payType === "random" ? `${nova(minPayVoro)}–${nova(maxPayVoro)} random per Work` : `${nova(payVoro)} ${payType}`}${paySchedule ? ` • ${paySchedule}` : ""} • **${listingType === "recurring" ? "Recurring listing" : "Single opening"}**.`
        });
      }

      if (id === "create_property_listing_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const inventoryMode = parts[1];
        const name = i.fields.getTextInputValue("name").trim();
        const type = i.fields.getTextInputValue("type").trim().toLowerCase();
        const ownership = i.fields.getTextInputValue("ownership").trim().toLowerCase();
        const rooms = i.fields.getTextInputValue("rooms").split("|").map(x=>x.trim());
        const bedrooms = Number(rooms[0] || 0);
        const bathrooms = Number(rooms[1] || 0);
        const unitsInput = rooms[2] ? Number(rooms[2]) : 1;
        const cost = toVoro(i.fields.getTextInputValue("cost"));

        if (!["apartment","house","dorm","luxury","commercial"].includes(type)) {
          throw new Error("Property type must be apartment, house, dorm, luxury, or commercial.");
        }
        if (!["rent","own"].includes(ownership)) throw new Error("Ownership must be rent or own.");
        if (cost === null || cost < 0) throw new Error("Enter a valid monthly cost.");
        if (!["unique","recurring"].includes(inventoryMode)) throw new Error("Invalid property inventory type.");

        const totalUnits = inventoryMode === "recurring"
          ? (Number.isInteger(unitsInput) && unitsInput > 1 ? unitsInput : null)
          : 1;

        if (inventoryMode === "recurring" && !totalUnits) {
          throw new Error("Recurring properties need more than 1 unit in Bedrooms | Bathrooms | Units.");
        }

        const result = unwrap(await db.rpc("create_property_listing",{
          p_name:name,
          p_property_type:type,
          p_ownership_status:ownership,
          p_bedrooms:Number.isFinite(bedrooms) ? bedrooms : 0,
          p_bathrooms:Number.isFinite(bathrooms) ? bathrooms : 0,
          p_monthly_cost_voro:cost,
          p_inventory_mode:inventoryMode,
          p_total_units:totalUnits
        }),"create property listing");

        const row = Array.isArray(result) ? result[0] : result;

        return respond(i,{
          content:`✅ **${name}** added to Property Listings as a **${inventoryMode === "recurring" ? `recurring ${totalUnits}-unit property` : "unique property"}** at **${nova(cost)}/month**.`
        });
      }

      if (id === "create_property_assigned_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const characterId = parts[1];
        const inventoryMode = parts[2];
        const c = await characterById(characterId);
        if (!c) throw new Error("Character not found.");

        const name = i.fields.getTextInputValue("name").trim();
        const type = i.fields.getTextInputValue("type").trim().toLowerCase();
        const ownership = i.fields.getTextInputValue("ownership").trim().toLowerCase();
        const rooms = i.fields.getTextInputValue("rooms").split("|").map(x=>x.trim());
        const bedrooms = Number(rooms[0] || 0);
        const bathrooms = Number(rooms[1] || 0);
        const unitsInput = rooms[2] ? Number(rooms[2]) : 1;
        const cost = toVoro(i.fields.getTextInputValue("cost"));

        if (!["apartment","house","dorm","luxury","commercial"].includes(type)) {
          throw new Error("Property type must be apartment, house, dorm, luxury, or commercial.");
        }
        if (!["rent","own"].includes(ownership)) throw new Error("Ownership must be rent or own.");
        if (cost === null || cost < 0) throw new Error("Enter a valid monthly cost.");
        if (!["unique","recurring"].includes(inventoryMode)) throw new Error("Invalid property inventory type.");

        const totalUnits = inventoryMode === "recurring"
          ? (Number.isInteger(unitsInput) && unitsInput > 1 ? unitsInput : null)
          : 1;

        if (inventoryMode === "recurring" && !totalUnits) {
          throw new Error("Recurring properties need more than 1 unit in Bedrooms | Bathrooms | Units.");
        }

        const result = unwrap(await db.rpc("create_and_assign_property",{
          p_character_id:c.id,
          p_discord_user_id:c.owner_discord_id,
          p_name:name,
          p_property_type:type,
          p_ownership_status:ownership,
          p_bedrooms:Number.isFinite(bedrooms) ? bedrooms : 0,
          p_bathrooms:Number.isFinite(bathrooms) ? bathrooms : 0,
          p_monthly_cost_voro:cost,
          p_inventory_mode:inventoryMode,
          p_total_units:totalUnits
        }),"create and assign property");

        const assigned = Array.isArray(result) ? result[0] : result;

        return respond(i,{
          content:`✅ **${name}** was created and assigned to **${c.name}**${inventoryMode === "recurring" ? ` (Unit ${assigned?.unit_number_out || 1}; remaining units stay listed)` : ""}.`
        });
      }


      if (id === "create_vehicle_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const characterId = parts[1];
        const name = i.fields.getTextInputValue("name").trim();
        const yf = i.fields.getTextInputValue("year_fuel").split("|").map(x=>x.trim());
        const year = yf[0] ? Number(yf[0]) : null;
        const fuelType = yf[1] || "regular";
        const tank = Number(i.fields.getTextInputValue("tank"));
        const mileage = Number(i.fields.getTextInputValue("mileage"));
        const valueRaw = i.fields.getTextInputValue("value").trim();
        const valueVoro = valueRaw ? toVoro(valueRaw) : null;

        const row = unwrap(await db.from("vehicles").insert({
          character_id:characterId,
          name,
          vehicle_name:name,
          year:Number.isFinite(year) ? year : null,
          fuel_type:fuelType,
          tank_size_gallons:Number.isFinite(tank) ? tank : null,
          fuel_percent:100,
          mileage:Number.isFinite(mileage) ? mileage : 0,
          condition_percent:100,
          insurance_status:"active",
          registration_status:"current",
          estimated_value_voro:valueVoro,
          for_sale:false,
          is_active:true
        }).select().single(),"create vehicle");

        return respond(i,{content:`✅ Vehicle **${row.name}** was assigned to the character.`});
      }

      if (id === "create_vehicle_marketplace_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const name = i.fields.getTextInputValue("name").trim();
        const yf = i.fields.getTextInputValue("year_fuel").split("|").map(x=>x.trim());
        const year = yf[0] ? Number(yf[0]) : null;
        const fuelType = yf[1] || "regular";
        const tank = Number(i.fields.getTextInputValue("tank"));
        const mileage = Number(i.fields.getTextInputValue("mileage"));
        const priceVoro = toVoro(i.fields.getTextInputValue("price"));

        if (!name) throw new Error("Vehicle name cannot be blank.");
        if (priceVoro === null || priceVoro <= 0) throw new Error("Enter a valid sale price.");

        const row = unwrap(await db.from("vehicles").insert({
          character_id:null,
          name,
          vehicle_name:name,
          year:Number.isFinite(year) ? year : null,
          fuel_type:fuelType,
          tank_size_gallons:Number.isFinite(tank) ? tank : null,
          fuel_percent:100,
          mileage:Number.isFinite(mileage) ? mileage : 0,
          condition_percent:100,
          insurance_status:"active",
          registration_status:"current",
          estimated_value_voro:priceVoro,
          sale_price_voro:priceVoro,
          for_sale:true,
          is_active:true,
          listed_at:new Date().toISOString()
        }).select().single(),"create marketplace vehicle");

        return respond(i,{
          content:`✅ **${row.year ? `${row.year} ` : ""}${row.name}** was added to the Vehicle Marketplace for **${nova(row.sale_price_voro)}**.`
        });
      }


      if (id === "create_subscription_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const characterId = parts[1];
        const name = i.fields.getTextInputValue("name").trim();
        const tier = i.fields.getTextInputValue("tier").trim() || null;
        const cost = toVoro(i.fields.getTextInputValue("cost"));
        const next = i.fields.getTextInputValue("next").trim() || null;
        const actionKey = i.fields.getTextInputValue("action_key").trim() || null;

        if (cost === null) throw new Error("Enter a valid monthly cost.");

        const checking = await accountFor(characterId,"checking");
        const row = unwrap(await db.from("subscriptions").insert({
          character_id:characterId,
          name,
          tier,
          monthly_cost_voro:cost,
          next_charge_date:next,
          status:"active",
          checking_account_id:checking?.id || null
        }).select().single(),"create subscription");

        if (actionKey) {
          try {
            await db.rpc("create_subscription_action_from_template",{
              p_subscription_id:row.id,
              p_subscription_key:actionKey
            });
          } catch (e) {
            console.warn("[subscription action template]",e.message);
          }
        }

        return respond(i,{content:`✅ Subscription **${row.name}** created for **${nova(cost)}/month**.`});
      }

      if (id === "business_owner_draw_modal") {
        const businessId=parts[1];
        const c=await currentCharacter(i);
        const business=unwrap(await db.from("businesses")
          .select("id,name,owner_character_id")
          .eq("id",businessId).limit(1),"owner draw modal business")?.[0];
        if(!business) throw new Error("Business not found.");
        if(!isModerator(i) && business.owner_character_id!==c.id) throw new Error("Only the business owner can take an owner draw.");

        const amount=toVoro(i.fields.getTextInputValue("amount"));
        if(amount===null || amount<=0) throw new Error("Enter a valid owner draw amount.");

        const result=unwrap(await db.rpc("business_owner_draw",{
          p_business_id:businessId,
          p_owner_character_id:business.owner_character_id,
          p_discord_user_id:i.user.id,
          p_amount_voro:amount
        }),"business owner draw");
        const r=Array.isArray(result)?result[0]:result;

        // Owner pay is private financial activity.
        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("💸 Owner Draw Complete")
            .setDescription(`**${business.name}** paid its owner **${nova(r?.amount_voro_out||amount)}**.`)
            .addFields(
              {name:"Business Balance",value:nova(r?.business_balance_after_voro_out||0),inline:true},
              {name:"Owner Checking",value:nova(r?.owner_balance_after_voro_out||0),inline:true}
            )]
        });
      }

      if (id === "business_owner_salary_modal") {
        const businessId=parts[1];
        const c=await currentCharacter(i);
        const business=unwrap(await db.from("businesses")
          .select("id,name,owner_character_id")
          .eq("id",businessId).limit(1),"owner salary modal business")?.[0];
        if(!business) throw new Error("Business not found.");
        if(!isModerator(i) && business.owner_character_id!==c.id) throw new Error("Only the business owner can set owner salary.");

        const amount=toVoro(i.fields.getTextInputValue("amount"));
        const schedule=i.fields.getTextInputValue("schedule").trim().toLowerCase();
        if(amount===null || amount<=0) throw new Error("Enter a valid salary amount.");
        if(!["weekly","biweekly","monthly"].includes(schedule)){
          throw new Error("Schedule must be weekly, biweekly, or monthly.");
        }

        const result=unwrap(await db.rpc("set_business_owner_salary",{
          p_business_id:businessId,
          p_owner_character_id:business.owner_character_id,
          p_discord_user_id:i.user.id,
          p_salary_voro:amount,
          p_schedule:schedule
        }),"set business owner salary");
        const r=Array.isArray(result)?result[0]:result;

        return respond(i,{
          embeds:[new EmbedBuilder()
            .setTitle("💼 Owner Salary Saved")
            .setDescription(`**${business.name}** will pay its owner **${nova(amount)}** ${schedule}.`)
            .addFields({name:"Next Payday",value:r?.next_pay_at_out ? `<t:${Math.floor(new Date(r.next_pay_at_out).getTime()/1000)}:F>` : "Scheduled"})]
        });
      }


      if (id === "create_business_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const ownershipType = parts[1];
        const ownerCharacterId = parts[2] === "none" ? null : parts[2];
        const name = i.fields.getTextInputValue("name").trim();
        const type = i.fields.getTextInputValue("type").trim().toLowerCase();

        if (!["shop","restaurant"].includes(type)) {
          throw new Error("Business type must be shop or restaurant.");
        }

        const business = unwrap(await db.from("businesses").insert({
          name,
          business_type:type,
          ownership_type:ownershipType,
          owner_character_id:ownerCharacterId,
          is_global:true,
          status:"open"
        }).select().single(),"create business");

        if (ownershipType === "character" && ownerCharacterId) {
          // Each owned business gets its own business account.
          const account = await businessAccountFor(business.id);
          if (!account) {
            unwrap(await db.from("bank_accounts").insert({
              character_id:ownerCharacterId,
              business_id:business.id,
              account_type:"business",
              balance_voro:0,
              status:"active"
            }),"create business account");
          }
        }

        return respond(i,{
          content:`✅ **${business.name}** was created as a ${type}.${ownershipType === "character" ? "\n👑 The assigned character is the **business owner**." : ""}\nNow choose what you want to do next:`,
          components:[buttonRow([
            {id:`business_bulk_add:${business.id}`,label:"Quick Add Menu",style:ButtonStyle.Success},
            {id:`business_view_catalog:${business.id}`,label:"View Catalog / Menu"},
            {id:`business_upload_logo:${business.id}`,label:"Upload Logo"}
          ])]
        });
      }

      if (id === "create_job_modal") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");

        const targetUserId = parts[1];
        const characterId = parts[2];
        const c = await characterById(characterId);
        if (!c || c.owner_discord_id !== targetUserId) throw new Error("Character/user mismatch.");

        const employer = i.fields.getTextInputValue("employer").trim();
        const position = i.fields.getTextInputValue("position").trim();
        const payRaw = i.fields.getTextInputValue("pay").trim();
        const payInfo = i.fields.getTextInputValue("pay_info").split("|").map(x=>x.trim().toLowerCase());
        const payType = payInfo[0] === "variable" ? "random" : payInfo[0];
        const paySchedule = payInfo[1] || null;
        const payParts = payRaw.split("|").map(x=>x.trim());
        const minPayVoro = payType === "random" ? toVoro(payParts[0]) : null;
        const maxPayVoro = payType === "random" ? toVoro(payParts[1]) : null;
        const payVoro = payType === "random" ? minPayVoro : toVoro(payRaw);
        const hoursText = i.fields.getTextInputValue("hours").trim();
        const weeklyHours = hoursText ? Number(hoursText) : null;

        if (!["salary","hourly","weekly","commission","custom","random"].includes(payType)) {
          throw new Error("Pay type must be salary, hourly, weekly, commission, custom, or random.");
        }
        if (payType === "random") {
          if (minPayVoro === null || maxPayVoro === null || minPayVoro < 0 || maxPayVoro < minPayVoro) {
            throw new Error("Random jobs need Pay entered as MIN | MAX, for example 50 | 500.");
          }
        } else if (payVoro === null) throw new Error("Enter a valid pay amount.");

        const job = unwrap(await db.from("jobs").insert({
          character_id:characterId,
          employer_name:employer,
          position,
          pay_type:payType,
          pay_amount_voro:payVoro,
          min_pay_voro:minPayVoro,
          max_pay_voro:maxPayVoro,
          pay_schedule:paySchedule,
          weekly_hour_limit:Number.isFinite(weeklyHours) ? weeklyHours : null,
          status:"pending"
        }).select().single(),"create job");

        unwrap(await db.from("job_contracts").insert({
          job_id:job.id,
          discord_user_id:targetUserId,
          offered_by_discord_id:i.user.id,
          status:"pending"
        }),"create job contract");

        let dm = false;
        try {
          const user = await client.users.fetch(targetUserId);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("💼 Employment Offer")
              .setDescription(`**${c.name}** has been offered **${position}** at **${employer}**.`)
              .addFields(
                {name:"Pay",value:payType === "random" ? `${nova(minPayVoro)}–${nova(maxPayVoro)} • random per Work` : `${nova(payVoro)} • ${payType}`,inline:true},
                {name:"Schedule",value:paySchedule || "Not specified",inline:true}
              )],
            components:[buttonRow([
              {id:`job_contract_accept:${job.id}`,label:"Accept Job",style:ButtonStyle.Success},
              {id:`job_contract_decline:${job.id}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
          dm = true;
        } catch {}

        return respond(i,{content:`✅ Job created for **${c.name}**. Contract is pending.${dm ? " The player was sent a DM." : ""}`});
      }

      if (id === "character_create_modal") {
        const name = i.fields.getTextInputValue("name").trim();
        if (!name) throw new Error("Character name cannot be blank.");
        const c = unwrap(await db.from("characters").insert({
          owner_discord_id:i.user.id,
          name
        }).select().single(),"create character");
        await setActiveCharacter(i.user.id,i.guildId,c.id);
        return respond(i, {content:`✅ **${name}** was created with **N1,000.00** starter funds and is now active here.`});
      }

      if (id === "character_edit_modal") {
        const c = await ensureOwnedCharacter(parts[1],i.user.id);
        const name = i.fields.getTextInputValue("name").trim();
        unwrap(await db.from("characters").update({name}).eq("id",c.id),"edit character");
        return respond(i, {content:`✅ Character renamed to **${name}**.`});
      }

      if (id === "character_remove_modal") {
        const c = await ensureOwnedCharacter(parts[1],i.user.id);
        const confirm = i.fields.getTextInputValue("confirm_name").trim();
        if (confirm !== c.name) throw new Error(`Name did not match. Type **${c.name}** exactly.`);
        unwrap(await db.from("characters").delete().eq("id",c.id),"remove character");
        return respond(i, {content:`🗑️ **${c.name}** and their attached John data were removed.`});
      }



      if (id === "admin_assign_job_modal") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");

        const targetUserId = parts[1];
        const characterId = parts[2];
        const c = await characterById(characterId);
        if (!c || c.owner_discord_id !== targetUserId) throw new Error("Character/user mismatch.");

        const employer = i.fields.getTextInputValue("employer").trim();
        const position = i.fields.getTextInputValue("position").trim();
        const payVoro = toVoro(i.fields.getTextInputValue("pay"));
        const payInfo = i.fields.getTextInputValue("pay_info").trim();
        const hoursRaw = i.fields.getTextInputValue("hours").trim();

        if (payVoro === null || payVoro < 0) throw new Error("Enter a valid pay amount.");

        const [payTypeRaw, payScheduleRaw] = payInfo.split("|").map(x=>x.trim().toLowerCase());
        const payTypeAliases = {
          salary:"salary",
          hourly:"hourly",
          commission:"commission",
          custom:"custom",
          stipend:"custom"
        };
        const payType = payTypeAliases[payTypeRaw];
        if (!payType) throw new Error("Pay type must be salary, hourly, weekly, commission, or custom.");

        const weeklyHours = hoursRaw && !Number.isNaN(Number(hoursRaw)) ? Number(hoursRaw) : null;

        const job = unwrap(await db.from("jobs").insert({
          character_id:characterId,
          employer_name:employer,
          position,
          pay_type:payType,
          pay_amount_voro:payVoro,
          pay_schedule:payScheduleRaw || null,
          weekly_hour_limit:weeklyHours,
          status:"pending"
        }).select().single(),"admin assign job");

        unwrap(await db.from("job_contracts").insert({
          job_id:job.id,
          discord_user_id:targetUserId,
          offered_by_discord_id:i.user.id,
          status:"pending"
        }),"create job contract");

        unwrap(await db.from("admin_audit_logs").insert({
          guild_id:i.guildId,
          moderator_discord_id:i.user.id,
          action_type:"assign_job",
          target_character_id:characterId,
          details:{
            job_id:job.id,
            employer_name:employer,
            position,
            pay_type:payType,
            pay_amount_voro:payVoro,
            pay_schedule:payScheduleRaw || null,
            weekly_hours:weeklyHours,
            schedule_text: hoursRaw || null
          }
        }),"audit assign job");

        let dmSent = false;
        try {
          const user = await client.users.fetch(targetUserId);
          await user.send({
            embeds:[new EmbedBuilder()
              .setTitle("💼 Employment Offer")
              .setDescription(`**${c.name}** has received a new job offer.`)
              .addFields(
                {name:"Employer",value:employer,inline:true},
                {name:"Position",value:position,inline:true},
                {name:"Pay",value:`${nova(payVoro)} • ${payType}`,inline:true},
                {name:"Pay Schedule",value:payScheduleRaw || "Not specified",inline:true},
                {name:"Weekly Hours",value:weeklyHours !== null ? String(weeklyHours) : (hoursRaw || "Not specified"),inline:true}
              )
              .setFooter({text:"Accepting activates the job and payroll."})],
            components:[buttonRow([
              {id:`job_contract_accept:${job.id}`,label:"Accept Job",style:ButtonStyle.Success},
              {id:`job_contract_decline:${job.id}`,label:"Decline",style:ButtonStyle.Danger}
            ])]
          });
          dmSent = true;
        } catch (e) {
          console.warn("[Job contract DM failed]", e.message);
        }

        return respond(i,{
          content:`✅ Job assigned to **${c.name}** as **${position}** at **${employer}**. Contract is pending.${dmSent ? " I sent the player a DM to accept it." : " I couldn't DM them, so the contract remains pending in John."}`
        });
      }

      if (id === "admin_end_job_modal") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");

        const targetUserId = parts[1];
        const characterId = parts[2];
        const jobId = parts[3];
        const reason = i.fields.getTextInputValue("reason").trim();
        const effectiveRaw = i.fields.getTextInputValue("effective").trim().toLowerCase();

        const jobs = unwrap(await db.from("jobs").select("*").eq("id",jobId).eq("character_id",characterId).limit(1),"end job");
        const job = jobs?.[0];
        if (!job) throw new Error("Job not found.");

        if (effectiveRaw.includes("pay period")) {
          // Current jobs schema has no dedicated termination_effective_at field for general jobs,
          // so mark suspended and preserve the request in audit log until payroll scheduling is added.
          unwrap(await db.from("jobs").update({status:"suspended"}).eq("id",jobId),"schedule job ending");
          unwrap(await db.from("admin_audit_logs").insert({
            guild_id:i.guildId,
            moderator_discord_id:i.user.id,
            action_type:"schedule_end_job",
            target_character_id:characterId,
            details:{job_id:jobId,reason,effective:"end_of_pay_period"}
          }),"audit scheduled end job");
        } else {
          unwrap(await db.from("jobs").update({status:"ended"}).eq("id",jobId),"end job now");
          unwrap(await db.from("admin_audit_logs").insert({
            guild_id:i.guildId,
            moderator_discord_id:i.user.id,
            action_type:"end_job",
            target_character_id:characterId,
            details:{job_id:jobId,reason,effective:"immediate"}
          }),"audit end job");
        }

        try {
          const user = await client.users.fetch(targetUserId);
          await user.send(`💼 **${job.position}** at **${job.employer_name}** for your character has been ${effectiveRaw.includes("pay period") ? "set to end at the end of the pay period" : "ended"}${reason ? `.\nReason: ${reason}` : "."}`);
        } catch {}

        return respond(i,{content:`✅ **${job.position}** at **${job.employer_name}** has been ${effectiveRaw.includes("pay period") ? "scheduled to end" : "ended"}.`});
      }

      if (id === "manage_edit") {
        if (!isModerator(i)) throw new Error("Moderator permissions required.");
        const kind = parts[1];
        const itemId = parts[2];
        const field = i.fields.getTextInputValue("field").trim();
        let newValue = i.fields.getTextInputValue("value").trim();
        const tableMap = {jobs:"jobs",properties:"properties",vehicles:"vehicles",businesses:"businesses",subscriptions:"subscriptions",characters:"characters"};
        const allowed = {
          jobs:["position","employer_name","pay_amount_voro","pay_type","pay_schedule","status"],
          properties:["name","property_type","ownership_status","bedrooms","bathrooms","monthly_cost_voro","status"],
          vehicles:["vehicle_name","year","fuel_type","fuel_percentage","mileage","condition_percentage","insurance_status","registration_status","estimated_range_miles","value_voro"],
          businesses:["name","business_type","status"],
          subscriptions:["name","tier","monthly_cost_voro","next_charge_date","status"],
          characters:["name"]
        };
        if (!allowed[kind]?.includes(field)) throw new Error(`That field cannot be edited here. Allowed: ${allowed[kind]?.join(", ")}`);
        if (["pay_amount_voro","monthly_cost_voro","value_voro"].includes(field)) newValue = Math.round(Number(newValue) * 100);
        else if (["year","bedrooms","bathrooms","fuel_percentage","mileage","condition_percentage","estimated_range_miles"].includes(field)) newValue = Number(newValue);

        unwrap(await db.from(tableMap[kind]).update({[field]:newValue}).eq("id",itemId),`edit ${kind}`);
        unwrap(await db.from("admin_audit_logs").insert({
          guild_id:i.guildId,
          moderator_discord_id:i.user.id,
          action_type:`edit_${kind}`,
          details:{id:itemId,field,new_value:newValue}
        }),"audit edit");
        return respond(i,{content:`✅ Updated **${field}**.`});
      }

      if (id === "admin_settings_modal") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");
        const starter = toVoro(i.fields.getTextInputValue("starter"));
        const taxPct = Number(i.fields.getTextInputValue("tax"));
        const overdraftRaw = i.fields.getTextInputValue("overdraft").trim().toLowerCase();
        if (starter === null || !Number.isFinite(taxPct)) throw new Error("Enter valid numbers.");
        const allowOverdraft = ["yes","true","on","1"].includes(overdraftRaw);

        unwrap(await db.from("economy_settings").upsert({
          guild_id:i.guildId,
          bank_name:BANK_NAME,
          starting_balance_voro:starter,
          nabit_tax_rate:taxPct/100,
          allow_overdraft:allowOverdraft
        },{onConflict:"guild_id"}),"update economy settings");

        unwrap(await db.from("admin_audit_logs").insert({
          guild_id:i.guildId,
          moderator_discord_id:i.user.id,
          action_type:"economy_settings_update",
          details:{starting_balance_voro:starter,nabit_tax_rate:taxPct/100,allow_overdraft:allowOverdraft}
        }),"audit settings");

        return respond(i,{content:"✅ Economy settings updated."});
      }

      if (id === "admin_balance_adjust") {
        if (!i.memberPermissions?.has("Administrator")) throw new Error("Administrator permission required.");

        const characterId = parts[1];
        const c = await characterById(characterId);
        if (!c) throw new Error("Character not found.");

        const amount = toVoro(i.fields.getTextInputValue("amount"));
        const reason = i.fields.getTextInputValue("reason").trim();
        if (amount === null || amount === 0) throw new Error("Enter a non-zero amount.");

        const account = await accountFor(characterId,"checking");
        if (!account) throw new Error(`${c.name} does not have an Equity Financial Checking account.`);

        const next = Number(account.balance_voro) + amount;
        if (next < 0) throw new Error("That adjustment would make the account negative.");

        unwrap(await db.from("bank_accounts")
          .update({balance_voro:next})
          .eq("id",account.id),"admin balance update");

        unwrap(await db.from("transactions").insert({
          character_id:characterId,
          account_id:account.id,
          amount_voro:Math.abs(amount),
          direction:amount>0?"credit":"debit",
          transaction_type:"admin_adjustment",
          memo:reason,
          reference_number:`ADMIN-${Date.now()}`,
          balance_after_voro:next
        }),"admin transaction");

        return respond(i,{
          content:`✅ **${c.name}**'s Checking balance adjusted by **${nova(amount)}**. New balance: **${nova(next)}**.`
        });
      }

      if (id === "part_route") {
        const [characterId,transitType,ticketType,discountType,fareString] = parts.slice(1);
        const c = await ensureOwnedCharacter(characterId,i.user.id);
        const account = await requireChecking(c.id);
        const fare = Number(fareString);
        if (Number(account.balance_voro) < fare) throw new Error(`Not enough Nova in ${BANK_NAME} Checking.`);

        const departure = i.fields.getTextInputValue("departure").trim();
        const arrival = i.fields.getTextInputValue("arrival").trim();
        const route = i.fields.getTextInputValue("route").trim() || "PAR-T";

        // Charge checking, ledger transaction, then save ticket.
        const newBalance = Number(account.balance_voro) - fare;
        unwrap(await db.from("bank_accounts").update({balance_voro:newBalance}).eq("id",account.id),"PAR-T debit");
        const ref = randomId("PART");
        unwrap(await db.from("transactions").insert({
          character_id: c.id,
          account_id: account.id,
          amount_voro: fare,
          direction: "debit",
          transaction_type: "par_t_ticket",
          description: `${transitType} ${ticketType}`,
          reference_type: "part_ticket",
          balance_after_voro: newBalance
        }),"PAR-T transaction");

        const ticket = await savePartTicket({
          characterId:c.id,
          accountId:account.id,
          transitType,
          ticketType,
          fareVoro:fare,
          discountType,
          route,
          departure,
          arrival
        });

        const now = new Date();
        const image = await renderPartTicket({
          passenger:c.name,
          transitType:transitType.replaceAll("_"," ").toUpperCase(),
          ticketType:ticketType.replaceAll("_"," ").toUpperCase(),
          route,
          departure,
          arrival,
          date:now.toLocaleDateString("en-US"),
          time:now.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}),
          fareVoro:fare,
          ticketId:ticket.ticket_id,
          status:"BOOKED"
        });

        return i.reply({
          content:`✅ **PAR-T trip booked for ${c.name}.** ${nova(fare)} was charged to ${BANK_NAME} Checking.`,
          files:[new AttachmentBuilder(image,{name:"part-ticket.png"})]
        });
      }
    }
  } catch (err) {
    console.error(err);
    const payload = { content:`⚠️ ${err.message || "Something went wrong."}` };
    if (i.deferred) await i.editReply(payload).catch(()=>{});
    else if (i.replied) await i.followUp({ ...payload, flags:64 }).catch(()=>{});
    else if (err?.code !== 10062) await i.reply({ ...payload, flags:64 }).catch(()=>{});
  }
});

client.on("error", error => console.error("[Discord client error]", error));


async function runBusinessOwnerSalaryMaintenance() {
  try {
    const rows=unwrap(await db.rpc("process_due_business_owner_salaries"),"business owner salary maintenance") || [];
    const payouts=Array.isArray(rows)?rows:[rows];

    for(const payout of payouts){
      if(!payout?.discord_user_id_out) continue;

      const paid=payout.status_out==="paid";
      const embed=new EmbedBuilder()
        .setTitle(paid ? "💼 Owner Payday" : "⚠️ Owner Salary Payment Failed")
        .setDescription(
          paid
            ? `**${payout.business_name_out}** paid **${payout.owner_name_out}** **${nova(payout.amount_voro_out)}**.`
            : `**${payout.business_name_out}** could not pay **${payout.owner_name_out}** the scheduled **${nova(payout.amount_voro_out)}** owner salary because the business account did not have enough Nova.`
        );

      if(paid && payout.owner_balance_after_voro_out!==null && payout.owner_balance_after_voro_out!==undefined){
        embed.addFields({name:"Owner Checking",value:nova(payout.owner_balance_after_voro_out),inline:true});
      }
      if(payout.business_balance_after_voro_out!==null && payout.business_balance_after_voro_out!==undefined){
        embed.addFields({name:"Business Balance",value:nova(payout.business_balance_after_voro_out),inline:true});
      }

      await sendJohnPrivateNotification(payout.discord_user_id_out,{embeds:[embed]});
    }
  } catch(e) {
    console.error("[Business Owner Salary] Maintenance error:",e.message);
  }
}

client.once(Events.ClientReady, async c => {
  console.log(`John logged in as ${c.user.tag}`);
  console.log("[JOHN BUILD] business-direct-hire-v6-logo-timeout");

  // Run housing billing shortly after login, then every 6 hours.
  // The SQL is idempotent, so a restart cannot create duplicate monthly bills.
  setTimeout(() => {
    runHousingMaintenance().catch(e => console.error("[Housing] Initial scheduler error:", e.message));
  }, 15000);

  const housingTimer = setInterval(() => {
    runHousingMaintenance().catch(e => console.error("[Housing] Scheduler error:", e.message));
  }, 6 * 60 * 60 * 1000);

  housingTimer.unref?.();

  // Owner salaries are private paydays. Process shortly after startup and every 6 hours.
  setTimeout(() => {
    runBusinessOwnerSalaryMaintenance().catch(e => console.error("[Business Owner Salary] Initial scheduler error:",e.message));
  }, 20000);

  const ownerSalaryTimer=setInterval(() => {
    runBusinessOwnerSalaryMaintenance().catch(e => console.error("[Business Owner Salary] Scheduler error:",e.message));
  }, 6 * 60 * 60 * 1000);

  ownerSalaryTimer.unref?.();
});

try {
  await testSupabaseConnection();
} catch (error) {
  console.error("[Supabase startup test failed]", error);
}

client.login(process.env.DISCORD_TOKEN);
