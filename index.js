const { chromium, firefox, webkit } = require('playwright');  // Importation de Playwright (peut utiliser chromium, firefox, webkit)

(async () => {
    // Lecture des arguments de la ligne de commande
    const mode = process.argv[2];
    const videoUrl = process.argv[3];
    const commentIndexArg = process.argv[4];
    const replyTextArg = process.argv.slice(5).join(" ");  // Tout ce qui suit l'index sera le texte de réponse (permet les espaces)

    if (!mode) {
        console.error("❌ Mode non spécifié. Veuillez indiquer 'tiktok.debugSelectors', 'tiktok.fetchComments' ou 'tiktok.reply'.");
        process.exit(1);
    }
    if (!videoUrl) {
        console.error("❌ URL de la vidéo TikTok manquante. Veuillez fournir l'URL de la vidéo en second argument.");
        process.exit(1);
    }

    // Validation supplémentaire pour le mode reply
    let commentIndex = null;
    let replyText = null;
    if (mode === 'tiktok.reply') {
        if (!commentIndexArg) {
            console.error("❌ En mode reply, veuillez fournir l'index du commentaire en troisième argument et le texte de réponse en quatrième argument.");
            process.exit(1);
        }
        commentIndex = parseInt(commentIndexArg, 10);
        if (isNaN(commentIndex) || commentIndex < 0) {
            console.error("❌ Index du commentaire invalide. Assurez-vous de fournir un nombre (>= 0).");
            process.exit(1);
        }
        replyText = replyTextArg;
        if (!replyText || replyText.trim() === "") {
            console.error("❌ Texte de réponse manquant ou vide. Fournissez le texte à envoyer en réponse.");
            process.exit(1);
        }
    }

    // Démarrage du navigateur (ici on utilise Firefox pour l'exemple, mais Chromium ou WebKit fonctionnent aussi)
    const browser = await firefox.launch({ headless: false });  // headless: false pour voir l'action, peut être mis à true en production
    const context = await browser.newContext();
    const page = await context.newPage();

    // Augmenter le timeout global par précaution (par défaut ~30s)
    page.setDefaultTimeout(30000);  // 30 secondes par défaut pour les actions/sélecteurs

    console.log("ℹ️ Ouverture de la page TikTok:", videoUrl);
    try {
        // Navigation vers la page de la vidéo TikTok
        await page.goto(videoUrl, { waitUntil: 'load', timeout: 60000 });
    } catch (err) {
        console.error("❌ Échec du chargement de la page TikTok:", err);
        await browser.close();
        process.exit(1);
    }
    console.log("✔️ Page TikTok chargée avec succès.");

    // Définition des ensembles de sélecteurs potentiels pour les éléments de la page
    const selectors = {
        commentItem: [
            'div[class*="DivCommentObject"]',
            '[data-e2e="comment-item"]',
            'li[class*="CommentItem"]'
        ],
        commentUser: [
            'a[href^="/@"]',
            '[data-e2e="comment-username"]'
        ],
        commentText: [
            '[data-e2e^="comment-text"]',
            'span[data-e2e^="comment-level"]',
            'div[class*="DivCommentSubContent"]'
        ],
        replyButton: [
            'button:has-text("Répondre")',
            'button:has-text("Reply")',
            '[data-e2e="comment-reply"]'
        ],
        commentInput: [
            '[data-e2e="comment-input"]',
            'textarea'
        ]
    };

    // Fonction utilitaire pour trouver le premier sélecteur valide d'une liste
    async function findWorkingSelector(selectorOptions) {
        for (const sel of selectorOptions) {
            try {
                // Attendre un court instant pour voir si ce sélecteur existe dans la page
                await page.waitForSelector(sel, { timeout: 3000, state: 'attached' });
                const elements = await page.$$(sel);
                if (elements && elements.length > 0) {
                    return sel;
                }
            } catch (e) {
                // Ignorer les timeouts pour tester le prochain sélecteur
            }
        }
        return null;
    }

    if (mode === 'tiktok.debugSelectors') {
        console.log("🔍 Mode debugSelectors: identification des sélecteurs de commentaires...");

        // Identification de chaque type de sélecteur
        const foundItemSel = await findWorkingSelector(selectors.commentItem);
        const foundUserSel = await findWorkingSelector(selectors.commentUser);
        const foundTextSel = await findWorkingSelector(selectors.commentText);
        const foundReplyBtnSel = await findWorkingSelector(selectors.replyButton);
        const foundInputSel = await findWorkingSelector(selectors.commentInput);

        // Afficher les sélecteurs trouvés ou indiquer ceux manquants
        if (foundItemSel) {
            console.log("✔️ Sélecteur 'commentItem' trouvé:", foundItemSel);
            const count = await page.$$eval(foundItemSel, els => els.length);
            console.log(`   -> Nombre d'éléments commentaire détectés: ${count}`);
        } else {
            console.warn("❌ Aucun sélecteur 'commentItem' valide n'a été trouvé.");
        }
        if (foundUserSel) {
            console.log("✔️ Sélecteur 'commentUser' trouvé:", foundUserSel);
        } else {
            console.warn("❌ Aucun sélecteur 'commentUser' valide n'a été trouvé.");
        }
        if (foundTextSel) {
            console.log("✔️ Sélecteur 'commentText' trouvé:", foundTextSel);
        } else {
            console.warn("❌ Aucun sélecteur 'commentText' valide n'a été trouvé.");
        }
        if (foundReplyBtnSel) {
            console.log("✔️ Sélecteur 'replyButton' trouvé:", foundReplyBtnSel);
        } else {
            console.warn("❌ Aucun sélecteur 'replyButton' valide n'a été trouvé.");
        }
        if (foundInputSel) {
            console.log("✔️ Sélecteur 'commentInput' trouvé:", foundInputSel);
        } else {
            console.warn("❌ Aucun sélecteur 'commentInput' valide n'a été trouvé.");
        }

        console.log("🔎 Mode debug terminé. Utilisez ces sélecteurs identifiés dans les autres modes.");
    } 

    else if (mode === 'tiktok.fetchComments') {
        console.log("🔍 Mode fetchComments: extraction des commentaires de la vidéo...");

        // Attendre que la liste de commentaires soit rendue (le conteneur principal des commentaires)
        try {
            await page.waitForSelector(
                'div[class*="CommentListContainer"], [data-e2e="comment-list"]',
                { timeout: 15000, state: 'visible' }
            );
        } catch (err) {
            console.error("❌ Les commentaires ne se sont pas chargés à temps (timeout).");
            await browser.close();
            process.exit(1);
        }

        // Récupérer tous les éléments de commentaire
        const commentItems = await page.$$('div[class*="DivCommentObject"], [data-e2e="comment-item"], li[class*="CommentItem"]');
        const totalComments = commentItems.length;
        if (totalComments === 0) {
            console.log("ℹ️ Aucun commentaire trouvé sur cette vidéo.");
        } else {
            console.log(`✔️ ${totalComments} commentaire(s) trouvé(s).`);
            for (let i = 0; i < totalComments; i++) {
                const comment = commentItems[i];
                // Extraire le nom d'utilisateur du commentaire
                let username = "Utilisateur inconnu";
                const userElem = await comment.$('a[href^="/@"], [data-e2e="comment-username"]');
                if (userElem) {
                    username = await userElem.innerText().catch(() => "Utilisateur");
                }
                // Extraire le texte du commentaire
                let text = "(commentaire vide)";
                const textElem = await comment.$('[data-e2e^="comment-text"], span[data-e2e^="comment-level"], div[class*="DivCommentSubContent"]');
                if (textElem) {
                    text = await textElem.innerText().catch(() => "(texte illisible)");
                }
                console.log(`→ Commentaire #${i} par ${username} : ${text}`);
            }
        }
    } 

    else if (mode === 'tiktok.reply') {
        console.log(`🔍 Mode reply: préparation de la réponse au commentaire #${commentIndex}...`);

        // Attendre que les commentaires soient visibles
        try {
            await page.waitForSelector(
                'div[class*="CommentListContainer"], [data-e2e="comment-list"]',
                { timeout: 15000, state: 'visible' }
            );
        } catch (err) {
            console.error("❌ Les commentaires ne se sont pas chargés, impossible de répondre.");
            await browser.close();
            process.exit(1);
        }

        // Récupérer la liste des commentaires
        const commentItems = await page.$$('div[class*="DivCommentObject"], [data-e2e="comment-item"], li[class*="CommentItem"]');
        if (commentItems.length === 0) {
            console.error("❌ Aucun commentaire présent sur la vidéo. Action annulée.");
            await browser.close();
            process.exit(1);
        }
        if (commentIndex >= commentItems.length) {
            console.error(`❌ Index de commentaire invalide (${commentIndex}). Seulement ${commentItems.length} commentaire(s) disponible(s).`);
            await browser.close();
            process.exit(1);
        }

        // Cibler le commentaire voulu
        const targetComment = commentItems[commentIndex];
        // Scroll jusqu'au commentaire cible (au cas où il n'est pas dans la vue)
        await targetComment.scrollIntoViewIfNeeded().catch(() => {});  // Ignorer les erreurs éventuelles de scroll

        // Trouver le bouton "Répondre" dans ce commentaire
        const replyButton = await targetComment.$('button:has-text("Répondre"), button:has-text("Reply"), [data-e2e="comment-reply"]');
        if (!replyButton) {
            console.error("❌ Bouton 'Répondre' introuvable pour le commentaire sélectionné.");
            await browser.close();
            process.exit(1);
        }

        console.log("✔️ Bouton 'Répondre' trouvé. Clic en cours...");
        try {
            await replyButton.click({ timeout: 5000 });
        } catch (err) {
            console.error("❌ Impossible de cliquer sur 'Répondre' (peut-être invisible ou désactivé).");
            await browser.close();
            process.exit(1);
        }

        // Attendre que le champ de saisie de réponse apparaisse
        let inputField;
        try {
            inputField = await page.waitForSelector('[data-e2e="comment-input"], textarea', { timeout: 5000, state: 'visible' });
        } catch (err) {
            console.error("❌ Champ de saisie pour la réponse non visible après clic.");
            await browser.close();
            process.exit(1);
        }

        console.log("✔️ Champ de saisie trouvé. Envoi du texte de réponse...");
        try {
            // Saisie du texte dans le champ
            await inputField.fill(replyText, { timeout: 5000 });
        } catch (err) {
            console.error("❌ Impossible d'écrire le texte dans le champ de réponse.");
            await browser.close();
            process.exit(1);
        }

        // Envoi (publication) de la réponse
        // Option 1: presser la touche Entrée pour valider l'envoi
        try {
            await inputField.press('Enter');
        } catch (err) {
            console.warn("⚠️ Échec de la validation par Entrée, tentative de clic sur le bouton d'envoi...");
            // Option 2: si Enter ne fonctionne pas, chercher un bouton Envoyer/Send
            const sendBtn = await page.$('button:has-text("Envoyer"), button:has-text("Send")');
            if (sendBtn) {
                try {
                    await sendBtn.click();
                } catch (err2) {
                    console.error("❌ Impossible de cliquer sur le bouton d'envoi de la réponse.", err2);
                    await browser.close();
                    process.exit(1);
                }
            } else {
                console.error("❌ Bouton d'envoi introuvable, la réponse n'a pas pu être envoyée.");
                await browser.close();
                process.exit(1);
            }
        }

        console.log(`✔️ Réponse envoyée au commentaire #${commentIndex} : "${replyText}"`);
        console.log("🎉 Action de réponse terminée avec succès.");
    } 

    else {
        console.error("❌ Mode inconnu :", mode);
    }

    // Fermeture du navigateur
    await browser.close();
})();

